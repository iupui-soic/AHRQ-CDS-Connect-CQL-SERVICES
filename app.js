'use strict';

const express = require('express');
const path = require('path');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const index = require('./routes/index');
const apiLibrary = require('./routes/api/library');
const cdsServices = require('./routes/cds-services');
const libsLoader = require('./lib/libraries-loader');
const hooksLoader = require('./lib/hooks-loader');

// Set up a default request size limit of 1mb, but allow it to be overridden via environment
const limit = process.env.CQL_SERVICES_MAX_REQUEST_SIZE || '1mb';

// Request timeout in milliseconds (default: 2 minutes)
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT, 10) || 120000;

// Rate limiting configuration (configurable via environment)
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100; // 100 requests per window

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

if(app.get('env') !== 'test') {
  app.use(logger(':date[iso] :remote-addr ":method :url" :status :res[content-length]'));
}
app.use(cors());
app.use(helmet());
app.use(bodyParser.json({
  limit,
  type: function (msg)  {
    return msg.headers['content-type'] && msg.headers['content-type'].startsWith('application/json');
  }
}));
app.use(bodyParser.urlencoded({
  limit,
  extended: false
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting - apply to API routes only (not health checks)
const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.app.get('env') === 'test' // Skip rate limiting in tests
});

// Request timeout middleware
const requestTimeout = (req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
};

// Health check endpoint - basic liveness probe
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness check endpoint - verifies dependencies are loaded
app.get('/ready', (req, res) => {
  const libs = libsLoader.get();
  const hooks = hooksLoader.get();
  const libraryCount = libs ? libs.all().length : 0;
  const hookCount = hooks ? hooks.all().length : 0;
  const isReady = libraryCount > 0 && hookCount > 0;

  const status = {
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks: {
      libraries: { loaded: libraryCount, status: libraryCount > 0 ? 'ok' : 'fail' },
      hooks: { loaded: hookCount, status: hookCount > 0 ? 'ok' : 'fail' }
    }
  };

  res.status(isReady ? 200 : 503).json(status);
});

app.use('/', index);
app.use('/api/library', apiLimiter, requestTimeout, apiLibrary);
app.use('/cds-services', apiLimiter, requestTimeout, cdsServices);

// error handler
app.use((err, req, res, next) => {
  // Log the error
  console.error((new Date()).toISOString(), `ERROR: ${err.message}\n  ${err.stack}`);

  const status = err.status || 500;
  const isApiRequest = req.path.startsWith('/api/') || req.path.startsWith('/cds-services');

  // Return JSON for API requests, render error page for others
  if (isApiRequest || req.accepts('json')) {
    const errorResponse = {
      error: err.message || 'Internal Server Error',
      status: status
    };
    // Include stack trace in development
    if (req.app.get('env') === 'development') {
      errorResponse.stack = err.stack;
    }
    res.status(status).json(errorResponse);
  } else {
    // Render error page for browser requests
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(status);
    res.render('error');
  }
});

module.exports = app;
