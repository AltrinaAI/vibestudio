"use client";

import { createContext } from "react";

/**
 * Lets the editor's in-gutter change bars trigger "Review changes" without
 * prop-drilling through the file routes. StudioLayout provides the toggle (it
 * owns the ?diff=worktree URL state); LiveEditor consumes it directly. Null when
 * no toggle is available (the bar then just sits as a passive indicator).
 */
export const ReviewToggleContext = createContext<(() => void) | null>(null);
