import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { logger } from '../lib/logger.js';
import { healthRouter } from './routes/health.js';
import { slackEventsRouter } from './routes/slack-events.js';

const app = express();

// Security headers
app.use(helmet());

// Parse JSON body, preserving raw body for Slack signature verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Routes
app.use('/', healthRouter);
app.use('/slack', slackEventsRouter);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server running');
});
