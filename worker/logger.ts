import { LogLevel, Logger } from "effect";

/**
 * One JSON line per entry, which Workers Logs indexes field by field. Errors go
 * to `console.error` so they keep their level there.
 */
export const WorkerLogger = Logger.layer([
  Logger.make((options) => {
    const line = Logger.formatJson.log(options);

    if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Error")) {
      console.error(line);
    } else {
      console.log(line);
    }
  }),
]);
