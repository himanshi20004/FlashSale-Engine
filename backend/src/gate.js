// In-process admission gate. Closed while Redis is down or being rebuilt.
export const gate = { open: false };
