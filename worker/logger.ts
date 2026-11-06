import { LogLevel, Logger } from "effect";

/**
 * One JSON line per entry, which Workers Logs indexes field by field. Warnings
 * and errors go to `console.warn` and `console.error` so they keep their level
 * there.
 */
export const WorkerLogger = Logger.layer([
  Logger.make((options) => {
    const line = Logger.formatJson.log(options);

    if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Error")) {
      console.error(line);
    } else if (options.logLevel === "Warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }),
]);
