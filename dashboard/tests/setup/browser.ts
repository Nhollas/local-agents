import { afterAll, afterEach, beforeAll } from "vitest";
import { browserWorker } from "../support/msw";
import "../../src/index.css";

beforeAll(async () => {
  await browserWorker.start({
    onUnhandledRequest: "error",
    quiet: true,
  });
});

afterEach(() => {
  browserWorker.resetHandlers();
});

afterAll(() => {
  browserWorker.stop();
});
