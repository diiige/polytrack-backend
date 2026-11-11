import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

const handleBodyParserError: ErrorRequestHandler = (error, _req, res, next) => {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  next(error);
};

app.use(handleBodyParserError);

export default app;
