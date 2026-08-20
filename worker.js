require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');

// Long-running content worker.
//
// Renders take ~11-20 minutes each, and a month of content is hours of
// continuous work. Any single crash, API 503, or process kill used to lose the
// entire run: the previous batch runner held its state in memory and died twice
// mid-render, discarding a finished script and finished narration both times.
//
// State therefore lives on disk and is written after EVERY transition, so the
// worst a kill can cost is the one video in flight. Restarting resumes.
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(__dirname, 'data', 'queue.json');
const POLL_MS = Number(process.env.WORKER_POLL_MS) || 60000;
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS) || 3;

class Worker {
  constructor() {
    this.logger = new Logger('Worker');
    this.stopping = false;
  }

  async loadQueue() {
    try {
      return JSON.parse(await fs.readFile(QUEUE_PATH, 'utf8'));
    } catch {
      return { topics: [] };
    }
  }

  // Written via a temp file and rename so a kill mid-write cannot leave a
  // truncated queue behind - the whole point of the file is surviving kills.
  async saveQueue(queue) {
    const tmp = `${QUEUE_PATH}.tmp`;
    await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(queue, null, 2));
    await fs.rename(tmp, QUEUE_PATH);
  }

  // A job left in `running` means the process died mid-render. It is retried
  // rather than abandoned, but the attempt is already counted so a job that
  // reliably kills the worker cannot loop forever.
  async reclaimStale(queue) {
    let reclaimed = 0;
    for (const job of queue.topics) {
      if (job.status === 'running') {
        job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        if (job.status === 'failed') job.error = 'exceeded attempts after interruption';
        reclaimed++;
      }
    }
    if (reclaimed) {
      this.logger.warn(`Reclaimed ${reclaimed} interrupted job(s) from a previous run`);
      await this.saveQueue(queue);
    }
  }

  nextJob(queue) {
    return queue.topics.find(j => j.status === 'pending' && (j.attempts || 0) < MAX_ATTEMPTS);
  }

  async runJob(job, agents) {
    const { writer, production } = agents;
    const strategy = {
      topic: job.topic,
      contentType: job.contentType || 'Story',
      angle: job.angle,
      targetAudience: process.env.TARGET_AUDIENCE,
      keywords: job.keywords || []
    };

    const script = await writer.generateScript(strategy);
    this.logger.info(`Script: "${script.title}" (${script.mainContent?.sections?.length} sections)`);

    const result = await production.processContent({
      strategy,
      script,
      thumbnail: { title: script.title, script },
      seo: { title: script.title, keywords: strategy.keywords }
    });

    return {
      productionId: result?.id,
      productionStatus: result?.status,
      title: script.title,
      videoPath: result?.assets?.finalVideo?.path || result?.assets?.video?.path || null
    };
  }

  async start() {
    this.logger.info('Content worker starting');

    const db = new Database();
    await db.initialize();
    const credentials = new CredentialManager();
    if (typeof credentials.initialize === 'function') await credentials.initialize();

    const agents = {
      writer: new ScriptWriterAgent(db, credentials),
      production: new ProductionManagementAgent(db, credentials)
    };
    await agents.production.initialize();

    while (!this.stopping) {
      const queue = await this.loadQueue();
      await this.reclaimStale(queue);
      const job = this.nextJob(queue);

      if (!job) {
        const done = queue.topics.filter(j => j.status === 'done').length;
        const failed = queue.topics.filter(j => j.status === 'failed').length;
        this.logger.info(`Queue idle (${done} done, ${failed} failed) - sleeping ${POLL_MS / 1000}s`);
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }

      job.status = 'running';
      job.attempts = (job.attempts || 0) + 1;
      job.startedAt = new Date().toISOString();
      await this.saveQueue(queue);

      const started = Date.now();
      this.logger.info(`[${job.id}] "${job.topic}" (attempt ${job.attempts}/${MAX_ATTEMPTS})`);

      try {
        const out = await this.runJob(job, agents);
        const latest = await this.loadQueue();
        const target = latest.topics.find(j => j.id === job.id);
        Object.assign(target, {
          status: 'done',
          finishedAt: new Date().toISOString(),
          minutes: Math.round((Date.now() - started) / 60000),
          ...out
        });
        await this.saveQueue(latest);
        this.logger.success(`[${job.id}] done in ${target.minutes}m - ${out.title}`);
      } catch (error) {
        const latest = await this.loadQueue();
        const target = latest.topics.find(j => j.id === job.id);
        target.error = String(error.message).slice(0, 300);
        target.status = target.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        target.finishedAt = new Date().toISOString();
        await this.saveQueue(latest);
        this.logger.error(`[${job.id}] ${target.status}: ${target.error}`);
        // A provider outage fails every job the same way; pause before the next.
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  stop() {
    this.stopping = true;
  }
}

if (require.main === module) {
  const worker = new Worker();
  // systemd sends SIGTERM on restart/stop. Finish the current render rather than
  // corrupting it, then exit cleanly.
  process.on('SIGTERM', () => { worker.logger.info('SIGTERM - finishing current job'); worker.stop(); });
  process.on('SIGINT', () => { worker.logger.info('SIGINT - finishing current job'); worker.stop(); });
  worker.start().catch(e => { console.error('Worker crashed:', e); process.exit(1); });
}

module.exports = { Worker };
