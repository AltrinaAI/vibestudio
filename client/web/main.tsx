import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";
import { initLogging } from "@/lib/log";
import "./globals.css";

// Capture uncaught errors / unhandled rejections and forward warn+error to the
// backend so they land in the on-disk server log (visible in a packaged app).
initLogging();

// No StrictMode: the terminal panes attach a pty + xterm in a mount effect and
// detach/dispose on unmount, with no idempotency guard — StrictMode's double-invoke
// would double-attach and leak the first xterm instance.
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
