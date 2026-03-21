import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/runs", () => HttpResponse.json([])),
];
