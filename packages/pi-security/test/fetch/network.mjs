import assert from "node:assert/strict";
import { createLab, cases } from "./lab.mjs";
const lab = await createLab();
try {
  for (const c of cases) {
    for (const verdict of ["allow", "deny"]) {
      const row = await lab.execute(c[verdict], c.host);
      console.log(JSON.stringify({ tool: c.name, verdict, ...row }));
      if (verdict === "allow") assert.equal(row.exitCode, 0, row.output);
      else {
        assert.notEqual(row.exitCode, 0);
        assert.match(row.output, /403|Forbidden|refused/i);
      }
    }
  }
  for (const cls of ["fetch", "read-only", "build-test"]) {
    const row = await lab.execute(lab.directCommand, "example.com", cls);
    console.log(JSON.stringify({ tool: "direct-curl", ...row }));
    assert.notEqual(row.exitCode, 0);
    assert.match(row.output, /EPERM|Operation not permitted/);
    assert.equal(lab.connectionCount(), 0);
  }
} finally {
  await lab.close();
}
