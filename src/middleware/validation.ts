import { Request, Response, NextFunction } from 'express';
import { body, validationResult, param, query } from 'express-validator';

// Validation error handler
export const handleValidationErrors = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
};

// Sanitize string inputs to prevent injection attacks
export const sanitizeString = (str: string | undefined): string => {
  if (!str) return '';
  return str
    .trim()
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .substring(0, 10000); // Limit length
};

// Validate email
export const validateEmail = body('email')
  .isEmail()
  .normalizeEmail()
  .withMessage('Invalid email address');

// Validate password strength
export const validatePassword = body('password')
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters')
  .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number');

// Validate session code format
export const validateSessionCode = param('code')
  .matches(/^[A-Z0-9]{8,}$/)
  .withMessage('Invalid session code format');

// Validate UUID
export const validateUUID = param('id')
  .isUUID()
  .withMessage('Invalid ID format');

// Validate code execution input
export const validateCodeExecution = [
  body('code')
    .notEmpty()
    .withMessage('Code is required')
    .isLength({ max: 100000 }) // 100KB limit
    .withMessage('Code is too large (max 100KB)'),
  body('language')
    .isIn(['javascript', 'python', 'java', 'cpp', 'c', 'typescript', 'go', 'rust'])
    .withMessage('Invalid language'),
  body('stdin')
    .optional()
    .isLength({ max: 10000 })
    .withMessage('Stdin is too large (max 10KB)'),
  handleValidationErrors
];

// Validate session creation
export const validateSessionCreation = [
  body('candidate_email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Invalid candidate email'),
  body('candidate_name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Candidate name must be between 1 and 100 characters'),
  body('time_limit')
    .optional()
    .isInt({ min: 60, max: 14400 }) // 1 minute to 4 hours
    .withMessage('Time limit must be between 60 and 14400 seconds'),
  body('assessment_id')
    .optional()
    .isUUID()
    .withMessage('Invalid assessment ID'),
  handleValidationErrors
];

// Validate assessment generation
export const validateAssessmentGeneration = [
  body('url')
    .optional()
    .isURL()
    .withMessage('Invalid URL format'),
  body('jobTitle')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Job title must be between 1 and 200 characters'),
  body('company')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Company name must be between 1 and 100 characters'),
  body('jobDescription')
    .optional()
    .trim()
    .isLength({ min: 10, max: 50000 })
    .withMessage('Job description must be between 10 and 50000 characters'),
  handleValidationErrors
];

// Validate video upload
// Note: FormData sends values as strings, so we need to handle that
export const validateVideoUpload = [
  body('sessionId')
    .notEmpty()
    .withMessage('Session ID is required')
    .custom((value) => {
      // Check if it's a valid UUID (FormData sends as string)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(value)) {
        throw new Error('Invalid session ID format');
      }
      return true;
    }),
  body('chunkIndex')
    .notEmpty()
    .withMessage('Chunk index is required')
    .custom((value) => {
      // FormData sends as string, convert to int and validate
      const index = parseInt(value, 10);
      if (isNaN(index) || index < 0) {
        throw new Error('Invalid chunk index');
      }
      return true;
    }),
  body('streamType')
    .optional()
    .isIn(['webcam', 'screenshare', 'combined'])
    .withMessage('Invalid stream type'),
  handleValidationErrors
];

// Validate AI interaction - flexible validation for various event types
// This allows tracking of various events: file operations, commands, AI interactions, etc.
export const validateAIIntraction = [
  body('sessionId')
    .isUUID()
    .withMessage('Invalid session ID'),
  body('eventType')
    .notEmpty()
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Event type is required and must be a string (1-100 characters)'),
  // Optional string fields with length limits
  body('promptText')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 10000 })
    .withMessage('Prompt text is too large (max 10KB)'),
  body('responseText')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 50000 })
    .withMessage('Response text is too large (max 50KB)'),
  body('codeSnippet')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 50000 })
    .withMessage('Code snippet is too large (max 50KB)'),
  body('codeBefore')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 50000 })
    .withMessage('Code before is too large (max 50KB)'),
  body('codeAfter')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 50000 })
    .withMessage('Code after is too large (max 50KB)'),
  body('model')
    .optional({ values: 'falsy' })
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Model name is too long (max 100 characters)'),
  // Optional number fields
  body('codeLineNumber')
    .optional({ values: 'falsy' })
    .isInt({ min: 0 })
    .withMessage('Code line number must be a non-negative integer'),
  body('tokensUsed')
    .optional({ values: 'falsy' })
    .isInt({ min: 0 })
    .withMessage('Tokens used must be a non-negative integer'),
  // Optional metadata object
  body('metadata')
    .optional()
    .custom((value) => {
      // Allow null, undefined, or object
      if (value === null || value === undefined) return true;
      if (typeof value === 'object' && !Array.isArray(value)) return true;
      return false;
    })
    .withMessage('Metadata must be an object, null, or undefined'),
  handleValidationErrors
];

// Validate code save
export const validateCodeSave = [
  body('session_id')
    .isUUID()
    .withMessage('Invalid session ID'),
  body('code')
    .notEmpty()
    .isLength({ max: 1000000 }) // 1MB limit
    .withMessage('Code is too large (max 1MB)'),
  body('language')
    .notEmpty()
    .isIn(['javascript', 'python', 'java', 'cpp', 'c', 'typescript', 'go', 'rust'])
    .withMessage('Invalid language'),
  handleValidationErrors
];

// Validate submission
export const validateSubmission = [
  body('code')
    .notEmpty()
    .isLength({ max: 1000000 }) // 1MB limit
    .withMessage('Code is too large (max 1MB)'),
  body('language')
    .notEmpty()
    .isIn(['javascript', 'python', 'java', 'cpp', 'c', 'typescript', 'go', 'rust'])
    .withMessage('Invalid language'),
  body('problemId')
    .optional()
    .isInt()
    .withMessage('Invalid problem ID'),
  body('sessionId')
    .isUUID()
    .withMessage('Invalid session ID'),
  body('testCases')
    .isArray()
    .withMessage('Test cases must be an array'),
  handleValidationErrors
];

// Input sanitization middleware
export const sanitizeInputs = (req: Request, res: Response, next: NextFunction) => {
  // Sanitize string fields in body
  if (req.body) {
    const stringFields = ['candidate_name', 'candidate_email', 'jobTitle', 'company', 'jobDescription', 'promptText'];
    stringFields.forEach(field => {
      if (req.body[field] && typeof req.body[field] === 'string') {
        req.body[field] = sanitizeString(req.body[field]);
      }
    });
  }
  next();
};

