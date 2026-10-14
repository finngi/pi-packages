import { test } from "node:test";
import {
  scopedBuildWrite,
  siblingWriteRefused,
  readOnlyWriteRefused,
} from "./fixtures/kernel/examples.mjs";

test("scoped build write succeeds", { skip: process.platform !== "darwin" }, scopedBuildWrite);
test("sibling write is refused", { skip: process.platform !== "darwin" }, siblingWriteRefused);
test(
  "read-only project write is refused",
  { skip: process.platform !== "darwin" },
  readOnlyWriteRefused,
);
