import { PrimaryStore } from "../../../bridge/db/primary-store.ts";

/** argv: [dbPath, backupsDir] -> stdout: one JSON line { count } */
async function run() {
  const [, , dbPath, backupsDir] = process.argv;
  const store = new PrimaryStore(dbPath, backupsDir);
  store.open();
  const count = store.countRuns();
  store.close();
  console.log(JSON.stringify({ count }));
}

run();
