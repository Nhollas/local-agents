import { HttpResponse, http } from "msw";

export const handlers = [http.get("/runs", () => HttpResponse.json([]))];
