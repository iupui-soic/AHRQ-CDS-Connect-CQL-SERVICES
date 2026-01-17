'use strict';

const express = require('express');
const path = require('path');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const helmet = require('helmet');
var cors = require('cors');

const index = require('./routes/index');
const apiLibrary = require('./routes/api/library');
const cdsServices = require('./routes/cds-services');
const libsLoader = require('./lib/libraries-loader');
const hooksLoader = require('./lib/hooks-loader');

// Set up a default request size limit of 1mb, but allow it to be overridden via environment
const limit = process.env.CQL_SERVICES_MAX_REQUEST_SIZE || '1mb';

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
app.use('/api/library', apiLibrary);
app.use('/cds-services', cdsServices);

// error handler
app.use((err, req, res, next) => {
  // Log the error
  console.error((new Date()).toISOString(), `ERROR: ${err.message}\n  ${err.stack}`);

  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
