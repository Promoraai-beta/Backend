#!/usr/bin/env node

/**
 * Security Audit Script
 * 
 * Checks for common security issues:
 * 1. Hardcoded API keys, secrets, tokens
 * 2. Exposed environment variables
 * 3. Missing .env files in .gitignore
 * 4. Sensitive data in code
 * 
 * Usage:
 *   node scripts/security-audit.js
 */

const fs = require('fs');
const path = require('path');

const issues = [];
const warnings = [];

// Patterns that indicate hardcoded secrets
const secretPatterns = [
  // API Keys
  /(api[_-]?key|apikey)\s*[=:]\s*['"](sk-|pk_|SG\.|AKIA|eyJ)[^'"]+['"]/gi,
  // Tokens
  /(token|access[_-]?token|bearer[_-]?token)\s*[=:]\s*['"][a-zA-Z0-9]{32,}['"]/gi,
  // Passwords
  /(password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/gi,
  // Secrets
  /(secret|secret[_-]?key|private[_-]?key)\s*[=:]\s*['"][a-zA-Z0-9]{20,}['"]/gi,
  // JWT secrets
  /(jwt[_-]?secret)\s*[=:]\s*['"][^'"]+['"]/gi,
  // Database credentials
  /(database[_-]?url|db[_-]?password|connection[_-]?string)\s*[=:]\s*['"][^'"]+['"]/gi,
];

// Files to check
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
const skipDirs = ['node_modules', '.next', 'dist', 'build', '.git', 'coverage', 'venv', '__pycache__'];

function shouldProcessFile(filePath) {
  const ext = path.extname(filePath);
  if (!extensions.includes(ext)) return false;
  
  const relativePath = path.relative(process.cwd(), filePath);
  return !skipDirs.some(skip => relativePath.includes(skip));
}

function checkFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(process.cwd(), filePath);
    
    // Check for hardcoded secrets
    secretPatterns.forEach((pattern, index) => {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(match => {
          // Skip if it's in a comment or example
          const matchIndex = content.indexOf(match);
          const beforeMatch = content.substring(Math.max(0, matchIndex - 50), matchIndex);
          const afterMatch = content.substring(matchIndex, Math.min(content.length, matchIndex + match.length + 50));
          
          // Skip if it's clearly an example or comment
          if (beforeMatch.includes('//') || beforeMatch.includes('#') || 
              beforeMatch.includes('example') || beforeMatch.includes('Example') ||
              beforeMatch.includes('TODO') || beforeMatch.includes('FIXME')) {
            return;
          }
          
          issues.push({
            file: relativePath,
            type: 'Hardcoded Secret',
            pattern: pattern.toString(),
            match: match.substring(0, 50) + '...',
            severity: 'HIGH'
          });
        });
      }
    });
    
    // Check for process.env usage (should use environment variables)
    const envVarUsage = content.match(/process\.env\.[A-Z_]+/g);
    if (envVarUsage) {
      // This is good - using environment variables
      // But check if sensitive vars are being logged
      if (content.includes('console.log') && content.includes('process.env')) {
        const logLines = content.split('\n').filter(line => 
          line.includes('console.log') && line.includes('process.env')
        );
        logLines.forEach(line => {
          // Check if it's logging the actual value (not just existence)
          if (line.includes('.apiKey') || line.includes('.SECRET') || line.includes('.PASSWORD')) {
            warnings.push({
              file: relativePath,
              type: 'Potential Secret Exposure',
              issue: 'Environment variable value might be logged',
              line: line.trim().substring(0, 100),
              severity: 'MEDIUM'
            });
          }
        });
      }
    }
    
  } catch (error) {
    // Skip files that can't be read
  }
}

function walkDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
      const filePath = path.join(dir, file);
      
      try {
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          if (!skipDirs.includes(file)) {
            walkDir(filePath);
          }
        } else if (stat.isFile() && shouldProcessFile(filePath)) {
          checkFile(filePath);
        }
      } catch (error) {
        // Skip files that can't be accessed
      }
    });
  } catch (error) {
    // Skip directories that can't be accessed
  }
}

function checkGitignore() {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  
  if (!fs.existsSync(gitignorePath)) {
    issues.push({
      file: '.gitignore',
      type: 'Missing .gitignore',
      issue: '.gitignore file not found',
      severity: 'HIGH'
    });
    return;
  }
  
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  
  const requiredPatterns = [
    '.env',
    '.env.local',
    '.env.*.local',
    'node_modules',
  ];
  
  requiredPatterns.forEach(pattern => {
    if (!gitignoreContent.includes(pattern)) {
      warnings.push({
        file: '.gitignore',
        type: 'Missing Pattern',
        issue: `Pattern "${pattern}" not found in .gitignore`,
        severity: 'MEDIUM'
      });
    }
  });
}

function checkEnvFiles() {
  const envFiles = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
  ];
  
  envFiles.forEach(envFile => {
    const envPath = path.join(process.cwd(), envFile);
    if (fs.existsSync(envPath)) {
      // Check if .env is in .gitignore (should be)
      const gitignorePath = path.join(process.cwd(), '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
        if (!gitignoreContent.includes(envFile) && !gitignoreContent.includes('.env*')) {
          issues.push({
            file: envFile,
            type: 'Env File Not Ignored',
            issue: `${envFile} exists but is not in .gitignore`,
            severity: 'HIGH'
          });
        }
      }
    }
  });
}

// Main execution
console.log('🔍 Running security audit...\n');

// Check .gitignore
checkGitignore();

// Check for .env files
checkEnvFiles();

// Walk through source files
const srcDir = path.join(process.cwd(), 'src');
if (fs.existsSync(srcDir)) {
  walkDir(srcDir);
} else {
  // Check current directory
  walkDir(process.cwd());
}

// Report results
console.log('📊 Security Audit Results\n');

if (issues.length === 0 && warnings.length === 0) {
  console.log('✅ No security issues found!');
  console.log('✅ All secrets are properly stored in environment variables');
  console.log('✅ .gitignore is properly configured');
} else {
  if (issues.length > 0) {
    console.log(`❌ Found ${issues.length} HIGH severity issue(s):\n`);
    issues.forEach((issue, index) => {
      console.log(`${index + 1}. ${issue.type} in ${issue.file}`);
      console.log(`   Issue: ${issue.issue || issue.match}`);
      console.log(`   Severity: ${issue.severity}\n`);
    });
  }
  
  if (warnings.length > 0) {
    console.log(`⚠️  Found ${warnings.length} warning(s):\n`);
    warnings.forEach((warning, index) => {
      console.log(`${index + 1}. ${warning.type} in ${warning.file}`);
      console.log(`   Issue: ${warning.issue}`);
      if (warning.line) {
        console.log(`   Line: ${warning.line}`);
      }
      console.log(`   Severity: ${warning.severity}\n`);
    });
  }
}

console.log('\n💡 Recommendations:');
console.log('1. Always use environment variables for sensitive data');
console.log('2. Never commit .env files to version control');
console.log('3. Use .env.example to document required environment variables');
console.log('4. Rotate API keys regularly');
console.log('5. Use different keys for development and production');
console.log('6. Never log environment variable values');

process.exit(issues.length > 0 ? 1 : 0);

