import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import http from 'http';
import { prisma } from './lib/prisma';
import apiRoutes from './routes';
import { videoStreamServer } from './websocket/video-stream';
import { securityHeaders, enforceTimer } from './middleware/security';
import { apiLimiter, executeLimiter, codeSaveLimiter, videoUploadLimiter, aiInteractionLimiter, liveMonitoringLimiter, authLimiter, sessionCodeLimiter } from './middleware/rate-limiter';
import { validateCodeExecution, validateSubmission, validateCodeSave } from './middleware/validation';
import { startInactivityMonitor } from './services/inactivity-monitor';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Create HTTP server for WebSocket support
const server = http.createServer(app);

// Middleware
// CORS configuration - MUST be before other middleware to handle OPTIONS preflight requests
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(null, true); // In development, allow all origins
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Access-Control-Allow-Origin', 
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Methods',
    'X-Idempotency-Key'
  ],
  exposedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
  preflightContinue: false
}));

// Handle OPTIONS requests explicitly (some browsers need this)
app.options('*', cors());

// Security headers (after CORS to avoid interfering with preflight)
app.use(securityHeaders);

// Body parsing with size limits
app.use(express.json({ limit: '10mb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for rate limiting (if behind reverse proxy)
app.set('trust proxy', 1);

// Serve uploaded video files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
// Serve HLS playlists and segments
app.use('/hls', express.static(path.join(process.cwd(), 'uploads', 'hls')));

// Judge0 configuration
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY || '';
const JUDGE0_BASE_URL = 'https://judge0-ce.p.rapidapi.com';

// Language IDs for Judge0
const LANGUAGE_IDS: Record<string, number> = {
  'javascript': 63,   // Node.js
  'python': 71,       // Python 3
  'java': 62,         // Java
  'cpp': 54,          // C++17
  'c': 50,            // C
  'typescript': 74,   // TypeScript
  'go': 60,           // Go
  'rust': 73,         // Rust
};

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend server is running' });
});

// Mount API routes
app.use('/api', apiRoutes);

// Code snapshots API - with debouncing and rate limiting
// Debounce map to prevent too frequent saves
const codeSaveDebounce = new Map<string, NodeJS.Timeout>();

app.post('/api/code-save', codeSaveLimiter, validateCodeSave, async (req: Request, res: Response) => {
  try {
    const { session_id, code, language } = req.body;

    // Debounce: Only save if last save was more than 2 seconds ago
    const debounceKey = session_id;
    const existingTimeout = codeSaveDebounce.get(debounceKey);
    
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout for saving
    const timeout = setTimeout(async () => {
      try {
        const line_count = code.split('\n').length;

        // Limit code size to prevent DB bloat
        const maxCodeSize = 1000000; // 1MB
        const codeToSave = code.length > maxCodeSize 
          ? code.substring(0, maxCodeSize) + '\n// ... [code truncated due to size]'
          : code;

        await prisma.codeSnapshot.create({
          data: {
            sessionId: session_id,
            code: codeToSave,
            lineCount: line_count,
            language
          }
        });
        
        codeSaveDebounce.delete(debounceKey);
      } catch (error) {
        console.error('Debounced code save error:', error);
        codeSaveDebounce.delete(debounceKey);
      }
    }, 2000); // 2 second debounce

    codeSaveDebounce.set(debounceKey, timeout);

    // Return immediately (don't wait for debounced save)
    res.json({ 
      success: true, 
      message: 'Code save queued',
      data: { sessionId: session_id, queued: true }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/code-save', async (req: Request, res: Response) => {
  try {
    const session_id = req.query.session_id as string;

    if (!session_id) {
      return res.status(400).json({ success: false, error: 'session_id required' });
    }

    const data = await prisma.codeSnapshot.findMany({
      where: {
        sessionId: session_id
      },
      orderBy: {
        timestamp: 'asc'
      }
    });

    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function to execute JavaScript in Node.js with security restrictions
async function executeJavaScript(code: string, timeoutMs: number = 5000): Promise<{ success: boolean; output?: string; error?: string; stack?: string }> {
  let output = '';
  let errorOutput = '';
  let timedOut = false;
  
  // Security: Block dangerous operations
  const dangerousPatterns = [
    /require\s*\(/g,
    /import\s+/g,
    /process\./g,
    /fs\./g,
    /child_process/g,
    /eval\s*\(/g,
    /Function\s*\(/g,
    /setTimeout\s*\(/g,
    /setInterval\s*\(/g,
    /XMLHttpRequest/g,
    /fetch\s*\(/g,
    /http\./g,
    /https\./g,
    /net\./g,
    /dns\./g,
    /os\./g,
    /crypto\./g,
    /cluster\./g,
    /worker_threads/g
  ];

  // Check for dangerous patterns
  for (const pattern of dangerousPatterns) {
    if (pattern.test(code)) {
      return {
        success: false,
        error: 'Code contains restricted operations for security reasons'
      };
    }
  }

  // Limit code size (prevent memory exhaustion)
  if (code.length > 100000) { // 100KB limit
    return {
      success: false,
      error: 'Code is too large (max 100KB)'
    };
  }
  
  // Capture console.log
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    output += args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return '[Object]';
        }
      }
      return String(arg);
    }).join(' ') + '\n';
    
    // Limit output size
    if (output.length > 100000) { // 100KB output limit
      output = output.substring(0, 100000) + '\n...[output truncated]';
    }
  };
  
  // Capture console.error
  const originalError = console.error;
  console.error = (...args: any[]) => {
    errorOutput += args.map(arg => String(arg)).join(' ') + '\n';
    
    // Limit error output size
    if (errorOutput.length > 10000) { // 10KB error limit
      errorOutput = errorOutput.substring(0, 10000) + '\n...[error output truncated]';
    }
  };

  try {
    // Execute code with timeout
    const startTime = Date.now();
    
    // Create a promise that rejects after timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        timedOut = true;
        reject(new Error('Execution timeout'));
      }, timeoutMs);
    });

    // Execute code
    const executionPromise = new Promise<void>((resolve, reject) => {
      try {
        // Use VM2-like isolation (basic implementation)
        // In production, use proper sandboxing like isolated-vm or Docker
        const func = new Function(code);
        func();
        resolve();
      } catch (err: any) {
        reject(err);
      }
    });

    // Race between execution and timeout
    await Promise.race([executionPromise, timeoutPromise]);

    // Restore console
    console.log = originalLog;
    console.error = originalError;

    if (timedOut) {
      return {
        success: false,
        error: `Execution timeout (${timeoutMs}ms)`
      };
    }

    // Build response
    const finalOutput = output.trim();
    const finalError = errorOutput.trim();
    
    if (finalError) {
      return { success: false, error: finalError, output: finalOutput || undefined };
    } else if (finalOutput) {
      return { success: true, output: finalOutput };
    } else {
      return { success: true, output: '' }; // Empty string for no output
    }
  } catch (err: any) {
    console.log = originalLog;
    console.error = originalError;
    
    if (timedOut) {
      return {
        success: false,
        error: `Execution timeout (${timeoutMs}ms)`
      };
    }
    
    return {
      success: false,
      error: err.message || err.toString(),
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    };
  }
}

// Helper function to execute code using Judge0
async function executeWithJudge0(code: string, language: string, stdin: string = '') {
  const languageId = LANGUAGE_IDS[language.toLowerCase()];
  
  if (!languageId) {
    return { success: false, error: `Language ${language} not supported` };
  }

  try {
    // Submit code to Judge0
    const submitResponse = await axios.post(
      `${JUDGE0_BASE_URL}/submissions`,
      {
        source_code: code,
        language_id: languageId,
        stdin: stdin
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': JUDGE0_API_KEY,
          'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
        }
      }
    );

    const token = submitResponse.data.token;

    // Poll for result (up to 10 attempts)
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

      const resultResponse = await axios.get(
        `${JUDGE0_BASE_URL}/submissions/${token}`,
        {
          headers: {
            'X-RapidAPI-Key': JUDGE0_API_KEY,
            'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
          }
        }
      );

      const result = resultResponse.data;

      // Status 1-2 means still processing
      if (result.status.id === 1 || result.status.id === 2) {
        continue;
      }

      // Status 3 means successful
      if (result.status.id === 3) {
        return {
          success: true,
          output: result.stdout || '',
          stderr: result.stderr || '',
          time: result.time
        };
      }

      // Status 4+ means runtime error, compile error, etc.
      return {
        success: false,
        error: result.stderr || result.compile_output || result.message || 'Execution failed',
        output: result.stdout || ''
      };
    }

    return { success: false, error: 'Execution timeout' };
  } catch (error: any) {
    return { success: false, error: error.message || 'Judge0 execution failed' };
  }
}

// Helper function to run test cases (for JavaScript)
function runTestCases(code: string, testCases: Array<{name: string, input: any[], expected: any, visible?: boolean}>, fnName: string) {
  try {
    // Create an isolated context for code execution
    const context: any = {};
    const func = new Function('context', `
      ${code}
      // Store function in context
      context.${fnName} = ${fnName};
    `);
    
    // Execute code in context
    func(context);
    
    const __fn = context[fnName];
    if (!__fn || typeof __fn !== 'function') {
      throw new Error(`Function ${fnName} not found or not callable`);
    }

    const results = [];
    for (const tc of testCases) {
      try {
        const actual = __fn.apply(null, tc.input);
        const passed = JSON.stringify(actual) === JSON.stringify(tc.expected);
        const isVisible = tc.visible !== false; // Default to visible if not specified
        
        // For hidden tests, don't include expected/actual details
        if (isVisible) {
          results.push({
            name: tc.name,
            passed,
            expected: JSON.stringify(tc.expected),
            actual: JSON.stringify(actual),
            error: passed ? undefined : `Expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(actual)}`
          });
        } else {
          // Hidden test - only pass/fail, no details
          results.push({
            name: tc.name,
            passed,
            error: passed ? undefined : 'Test failed'
          });
        }
      } catch (e: any) {
        const isVisible = tc.visible !== false;
        results.push({
          name: tc.name,
          passed: false,
          error: isVisible ? (e.message || String(e)) : 'Test failed'
        });
      }
    }
    
    return results;
  } catch (err: any) {
    return [{
      name: 'Execution Error',
      passed: false,
      error: err.message || err.toString()
    }];
  }
}

// Code submission API - runs ALL tests (visible + hidden)
// Uses transaction for atomicity and idempotency support
app.post('/api/submit', enforceTimer, validateSubmission, async (req: Request, res: Response) => {
  const { code, language, problemId, sessionId, testCases, idempotencyKey } = req.body;

  // Check idempotency - prevent duplicate submissions
  if (idempotencyKey && sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId }
    });
    
    if (session?.status === 'submitted') {
      // Return existing submission if already submitted
      const existingSubmission = await prisma.submission.findFirst({
        where: { sessionId },
        orderBy: { submittedAt: 'desc' }
      });
      
      if (existingSubmission) {
        return res.json({
          success: true,
          submission: {
            id: existingSubmission.id,
            testResults: existingSubmission.testResults,
            score: existingSubmission.score,
            passed: existingSubmission.passedTests,
            total: existingSubmission.totalTests,
            passedVisible: (existingSubmission.testResults as any)?.filter((t: any) => 
              testCases.find((tc: any) => tc.name === t.name && tc.visible) && t.passed
            )?.length || 0,
            totalVisible: testCases.filter((tc: any) => tc.visible).length
          },
          message: 'Submission already processed (idempotent)'
        });
      }
    }
  }

  // Use transaction to ensure atomicity
  try {
    const result = await prisma.$transaction(async (tx) => {
      let allTestResults = [];

      if (language === 'javascript') {
        // Extract function name
        const fnMatch = code.match(/function\s+([a-zA-Z0-9_]+)/);
        if (!fnMatch) {
          throw new Error('Could not detect function name. Please define a named function.');
        }
        
        const fnName = fnMatch[1];
        
        // Run all test cases (visible + hidden) with secure execution
        allTestResults = runTestCases(code, testCases, fnName);
      } else {
        throw new Error('Final submission with hidden tests currently only supports JavaScript');
      }

      // Calculate score
      const passed = allTestResults.filter(t => t.passed).length;
      const total = allTestResults.length;
      const score = total > 0 ? Math.round((passed / total) * 100) : 0;

      // Store submission and update session atomically
      let submissionId = null;
      if (sessionId) {
        const submission = await tx.submission.create({
          data: {
            sessionId: sessionId,
            problemId: problemId,
            code: code.substring(0, 1000000), // 1MB limit
            language,
            testResults: allTestResults as any,
            score,
            passedTests: passed,
            totalTests: total
          }
        });

        submissionId = submission.id;

        // Update session status to 'submitted' (atomic)
        await tx.session.update({
          where: { id: sessionId },
          data: {
            status: 'submitted',
            submittedAt: new Date()
          }
        });
      }

      return {
        submissionId,
        allTestResults,
        score,
        passed,
        total
      };
    });

    res.json({
      success: true,
      submission: {
        id: result.submissionId,
        testResults: result.allTestResults,
        score: result.score,
        passed: result.passed,
        total: result.total,
        passedVisible: result.allTestResults.filter((t: any) => 
          testCases.find((tc: any) => tc.name === t.name && tc.visible) && t.passed
        ).length,
        totalVisible: testCases.filter((tc: any) => tc.visible).length
      }
    });
  } catch (error: any) {
    console.error('Submission error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to submit code' 
    });
  }
});

// Code execution API
app.post('/api/execute', executeLimiter, validateCodeExecution, async (req: Request, res: Response) => {
  try {
    const { code, language, stdin } = req.body;

    // For JavaScript, execute in Node.js (fast and reliable)
    if (language === 'javascript') {
      const result = await executeJavaScript(code, 5000); // 5 second timeout
      res.json({ success: true, result });
    } else {
      // For other languages, use Judge0 (already sandboxed)
      if (!JUDGE0_API_KEY) {
        res.json({ 
          success: true, 
          result: { 
            success: false, 
            error: 'Judge0 API key not configured. Please add JUDGE0_API_KEY to .env' 
          } 
        });
      } else {
        const result = await executeWithJudge0(code, language, stdin || '');
        res.json({ success: true, result });
      }
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Initialize WebSocket server
videoStreamServer.initialize(server);

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server initialized on ws://localhost:${PORT}/ws/video`);
  
  // Start inactivity monitoring service
  startInactivityMonitor();
});

