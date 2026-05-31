"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

interface MarkdownProps {
  content: string;
  /** Skill root (absolute) used to resolve relative images via /api/raw. */
  root: string;
  /** Called when the user clicks a relative file link inside the body. */
  onNavigate?: (rel: string) => void;
}

function isRelative(href: string | undefined): href is string {
  if (!href) return false;
  if (/^[a-z]+:\/\//i.test(href)) return false;
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("mailto:")) return false;
  return true;
}

function normalizeRel(href: string): string {
  return href.split("#")[0].split("?")[0].replace(/^\.\//, "");
}

export default function Markdown({ content, root, onNavigate }: MarkdownProps) {
  const components: Components = {
    a({ node, href, children, ...props }) {
      void node;
      if (isRelative(href) && onNavigate) {
        const rel = normalizeRel(href);
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(rel);
            }}
            title={`Open ${rel}`}
            {...props}
          >
            {children}
            <span className="text-muted">&nbsp;↗</span>
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
    img({ node, src, alt, ...props }) {
      void node;
      let resolved = typeof src === "string" ? src : "";
      if (isRelative(resolved)) {
        const rel = normalizeRel(resolved);
        resolved = `/api/raw?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
      }
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={resolved} alt={alt ?? ""} {...props} />;
    },
  };

  return (
    <div className="prose-skill">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
