import { Router } from "express";
import type { Request, Response } from "express";
import type { SessionManager } from "../session/manager.js";

/**
 * Create REST API routes for session management.
 *
 * These are supplementary to the WebSocket protocol —
 * useful for the Web UI to make REST calls for session CRUD.
 */
export function createRoutes(sessionManager: SessionManager): Router {
  const router = Router();

  // ─── Sessions ───────────────────────────────────────────────────────

  /**
   * GET /api/sessions — List all sessions (summaries).
   */
  router.get("/api/sessions", (_req: Request, res: Response) => {
    const sessions = sessionManager.listSessions();
    res.json({ ok: true, sessions });
  });

  /**
   * POST /api/sessions — Create a new session.
   */
  router.post("/api/sessions", (req: Request, res: Response) => {
    const title = req.body?.title as string | undefined;
    const session = sessionManager.createSession(title);
    res.status(201).json({
      ok: true,
      sessionId: session.sessionId,
      title: session.title,
      created: session.created,
    });
  });

  /**
   * GET /api/sessions/:id — Get full session transcript.
   */
  router.get("/api/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = sessionManager.getSession(id);
    if (!session) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    res.json({ ok: true, session });
  });

  /**
   * DELETE /api/sessions/:id — Delete a session.
   */
  router.delete("/api/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const deleted = sessionManager.deleteSession(id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    res.json({ ok: true, deleted: true });
  });

  // ─── Health ─────────────────────────────────────────────────────────

  /**
   * GET /api/health — Health check endpoint.
   */
  router.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      status: "healthy",
      timestamp: Date.now(),
      version: "0.1.0",
    });
  });

  return router;
}
