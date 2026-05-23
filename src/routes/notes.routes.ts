import { FastifyInstance } from "fastify";
import { authenticateFirebase } from "../middleware/auth.middleware";
import * as ctrl from "../controllers/notes.controller";

export default async function notesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  app.get("/", auth, ctrl.getNotes);
  app.get("/for-studio", auth, ctrl.getNotesForStudio);
  app.post("/", auth, ctrl.createNote);
  app.post("/attach-to-studio", auth, ctrl.attachNotesToStudio);
  app.patch<{ Params: { id: string } }>("/:id", auth, ctrl.updateNote);
  app.delete<{ Params: { id: string } }>("/:id", auth, ctrl.deleteNote);
  app.post<{ Params: { id: string } }>("/:id/pin", auth, ctrl.togglePin);
}
