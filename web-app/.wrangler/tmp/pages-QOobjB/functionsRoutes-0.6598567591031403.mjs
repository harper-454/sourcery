import { onRequest as __stream_js_onRequest } from "/Users/alexharper/.gemini/antigravity/scratch/mic-streamer/web-app/functions/stream.js"

export const routes = [
    {
      routePath: "/stream",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__stream_js_onRequest],
    },
  ]