"use client"

/**
 * There is no hosted demo mode in the Elysium starter: every route is answered by this app's own server, which holds
 * the wallet folder and talks to the chain. These are the plain fetch / EventSource the shared pages call.
 */
import { BRAND } from "../brand"

export const DEMO = false
export const DEMO_KEY_LABEL = ""
export const appFetch = (path: string, init?: RequestInit) => fetch(path, init)
export const appEvents = (path: string) => new EventSource(path)
export const TAB_NOTE = ""
export const REPO_URL = BRAND.repo
export const startEngine = async () => {}
