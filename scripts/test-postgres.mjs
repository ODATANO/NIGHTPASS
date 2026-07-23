import cds from '@sap/cds';

if (cds.env.requires?.db?.kind !== 'postgres') {
  throw new Error(`test:postgres requires the CAP production/PostgreSQL profile; got '${cds.env.requires?.db?.kind ?? 'unknown'}'`);
}

await cds.plugins;
const model = await cds.load('*');
await cds.deploy(model).to('db');

const db = await cds.connect.to('db');
const { SELECT } = cds.ql;
const entities = ['passport.Passports', 'midnight.SyncState', 'midnight.BackgroundJobs'];
for (const entity of entities) {
  const [{ count }] = await db.run(SELECT.from(entity).columns('count(*) as count'));
  if (!Number.isFinite(Number(count))) throw new Error(`Invalid row count returned for ${entity}`);
  console.log(`${entity}: ${count} row(s)`);
}

await db.disconnect();
console.log('PostgreSQL schema and core-entity smoke test passed.');
