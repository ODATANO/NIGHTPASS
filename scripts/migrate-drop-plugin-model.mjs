// Removes the NIGHTGATE plugin's definitions from `cds_model`, which `cds deploy` needs before it evolves such a database.
// Run with the server stopped: `node scripts/migrate-drop-plugin-model.mjs` reports, `--apply` writes. Then `npm run deploy`.
import cds from '@sap/cds';

const apply = process.argv.includes('--apply');
const PLUGIN = /^(midnight|Nightgate(Admin|Analytics|Indexer|Verify)?Service)(\.|$)/;
// Elements the model no longer has, by entity name.
const DROPPED_ELEMENTS = {
    Passports: ['attestation', 'attestation_ID'],
    DiligenceDoc: ['documentRef', 'documentRef_ID'],
    PredicateProofLog: ['predicateAttestationId'],
    Testers: ['encViewingKey']
};

const db = await cds.connect.to('db');
const placeholder = db.kind === 'postgres' ? '$1' : '?';

let stored;
try {
    stored = await db.run('SELECT csn FROM cds_model');
} catch {
    console.log('This database has no cds_model table, so it keeps no stored model. Nothing to do.');
    process.exit(0);
}
const raw = stored?.[0]?.csn ?? stored?.[0]?.CSN;
if (!raw) {
    console.log('cds_model is empty. Nothing to do.');
    process.exit(0);
}

const csn = JSON.parse(raw);
const definitions = csn.definitions ?? {};
const sqlName = (name) => name.replace(/\./g, '_');
const isView = (def) => !!(def?.query || def?.projection);

const removed = Object.keys(definitions).filter((name) => PLUGIN.test(name));
const entities = removed.filter((name) => definitions[name]?.kind === 'entity');
const views = entities.filter((name) => isView(definitions[name])).map(sqlName);
const tables = entities.filter((name) => !isView(definitions[name])).map(sqlName);
for (const name of removed) delete definitions[name];

const removedElements = [];
const columns = [];
for (const [name, def] of Object.entries(definitions)) {
    const dropped = DROPPED_ELEMENTS[name.split('.').pop()];
    if (!dropped || !def?.elements) continue;
    for (const element of dropped) {
        const elementDef = def.elements[element];
        if (!elementDef) continue;
        // An association has no column of its own, its foreign key element has.
        if (!isView(def) && elementDef.type !== 'cds.Association') columns.push([sqlName(name), element]);
        delete def.elements[element];
        removedElements.push(`${name}.${element}`);
    }
}

console.log(`definitions of the plugin in the stored model: ${removed.length}`);
console.log(`elements the model no longer has: ${removedElements.length}${removedElements.length ? ` (${removedElements.join(', ')})` : ''}`);
if (!removed.length && !removedElements.length) {
    console.log('The stored model is already clean.');
    process.exit(0);
}
console.log(`\nLeft in the database: ${views.length} view(s), ${tables.length} table(s), ${columns.length} column(s).`);
console.log('Keep these statements. They drop the rest and only work after `npm run deploy`:\n');
for (const view of views) console.log(`DROP VIEW IF EXISTS ${view};`);
for (const table of tables) console.log(`DROP TABLE IF EXISTS ${table};`);
for (const [table, column] of columns) console.log(`ALTER TABLE ${table} DROP COLUMN ${column};`);

if (!apply) {
    console.log('\nDry run. Run again with --apply to write the stored model.');
    process.exit(0);
}
await db.run(`UPDATE cds_model SET csn = ${placeholder}`, [JSON.stringify(csn)]);
console.log('\nStored model written. Run `npm run deploy` next.');
process.exit(0);
