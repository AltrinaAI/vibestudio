"use client";

import { useSyncExternalStore } from "react";

export interface Recent {
  root: string;
  name: string;
}

const KEY = "skillviewer-recents";
const MAX = 8;
const EMPTY: Recent[] = [];

const listeners = new Set<() => void>();
let cache: Recent[] | null = null;

function read(): Recent[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r.root === "string");
  } catch {
    return [];
  }
}

function snapshot(): Recent[] {
  if (cache === null) cache = read();
  return cache;
}

export function addRecent(r: Recent) {
  const next = [r, ...read().filter((x) => x.root !== r.root)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  cache = next;
  listeners.forEach((l) => l());
}

export function removeRecent(root: string) {
  const next = read().filter((x) => x.root !== root);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  cache = next;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useRecents(): Recent[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
