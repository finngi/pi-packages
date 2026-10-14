import { test } from "node:test";
import {
  scopedBuildWrite,
  siblingWriteRefused,
  readOnlyWriteRefused,
} from "./fixtures/kernel/examples.mjs";

test("scoped build write succeeds", scopedBuildWrite);
test("sibling write is refused", siblingWriteRefused);
test("read-only project write is refused", readOnlyWriteRefused);
