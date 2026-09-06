import { DatabaseSync } from 'node:sqlite';
import { connect } from '../runtime/transport.mjs';

// M0 probe: fixed fixture identities, no artifact repository or real generation yet.
export async function openKernel(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS active (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL);
    INSERT OR IGNORE INTO active VALUES (1, 'default');
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, version TEXT NOT NULL);`);
  const version = () => db.prepare('SELECT version FROM active WHERE id=1').get().version;
  const launch = (name, failSecond = false) => connect('child', 5000, {
    url: new URL('./endpoint.mjs', import.meta.url), args: [name, ...(failSecond ? ['fail-second'] : [])],
  });
  let runtime;
  try { runtime = await launch(version()); } catch (error) { db.close(); throw error; }
  let queue = Promise.resolve();
  const serial = (callback) => {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  };
  const read = (id) => {
    const row = db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('Task not found');
    return JSON.parse(row.body);
  };
  const save = (task) => db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(task.id, JSON.stringify(task));
  const call = async (client, input) => {
    const reply = await client.request(input);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  return {
    version,
    read,
    create(task) { return serial(() => {
      if (db.prepare('SELECT id FROM tasks WHERE id=?').get(task.id)) throw new Error('Duplicate task');
      save({ state: 'open', fields: {}, revision: 1, ...task });
    }); },
    describe(id) { return serial(() => call(runtime, { task: read(id) })); },
    act(id, action, input, expectedRevision) { return serial(async () => {
      const task = read(id);
      if (task.revision !== expectedRevision) throw new Error('Revision conflict');
      const decision = await call(runtime, { task, action, input });
      if (decision.kind === 'commit') {
        const description = await call(runtime, { task });
        if (!description.states.includes(decision.state)) throw new Error('Invalid state');
        save({ ...task, state: decision.state, fields: decision.fields, revision: task.revision + 1 });
      }
      return decision;
    }); },
    publish(nextVersion, { failSecond = false, crashAt, mapping = {} } = {}) { return serial(async () => {
      const next = await launch(nextVersion, failSecond);
      try {
        const definition = await call(next, { task: { state: 'open', fields: {} } });
        const tasks = db.prepare('SELECT body FROM tasks').all().map((row) => JSON.parse(row.body));
        const migrated = tasks.map((task) => {
          const state = mapping[task.state] ?? task.state;
          if (!definition.states.includes(state)) throw new Error(`Missing mapping for ${task.state}`);
          return state === task.state ? task : { ...task, state, revision: task.revision + 1 };
        });
        if (crashAt === 'prepared') process.exit(17);
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const task of migrated) save(task);
          db.prepare('UPDATE active SET version=? WHERE id=1').run(nextVersion);
          db.prepare('INSERT INTO releases(version) VALUES (?)').run(nextVersion);
          if (crashAt === 'transaction') process.exit(17);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        if (crashAt === 'switched') process.exit(17);
      } catch (error) { await next.close(); throw error; }
      const old = runtime;
      runtime = next;
      await old.close();
    }); },
    async close() { await queue; await runtime.close(); db.close(); },
  };
}
