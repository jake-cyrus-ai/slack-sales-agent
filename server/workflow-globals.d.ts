interface Body {
  // Provider payloads are validated at route/adapter boundaries.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
}
