import { Logger } from "./types.js";

export const defaultLogger: Logger = {
  warn: (msg: string) => console.warn(msg),
  log: (msg: string) => console.log(msg),
  debug: (msg: string) => { /* no-op */ },
};

export const silentLogger: Logger = {
  warn: () => {},
  log: () => {},
  debug: () => {},
};
