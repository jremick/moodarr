import { useEffect, useRef } from 'react';
import { ContractFault, type ErrorResult, type MoodarrResult, type PreviewResult } from './contracts';

export type ActionState =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'complete'; result: MoodarrResult }
  | { state: 'error'; error: ErrorResult };

export type RequestAttempt = ActionState | { state: 'cancelled' };
export type RequestLedger = Map<string, RequestAttempt>;

/** Discard acknowledgements after their originating card has been replaced. */
export function useCardLifetime() {
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  return current;
}

export function actionError(error: unknown, mutation = false): ErrorResult {
  // Untrusted transport errors must not expose raw host or provider details.
  const code = error instanceof ContractFault ? 'invalid_input'
    : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed';
  const preflight = /^(unsupported|unavailable|busy|cancelled|not_ready|invalid_input|stale_result|disposed|closed|capability)$/.test(code);
  return {
    status: mutation && !preflight ? 'uncertain' : 'error',
    code,
    message: mutation && !preflight
      ? 'Moodarr has not confirmed this action.'
      : code === 'stale_result' ? 'This result has changed. Use the latest Moodarr card.'
      : code === 'busy' ? 'Another action is still pending. Wait for its result, then try again.'
      : 'This action is unavailable. Ask ChatGPT for a fresh Moodarr result.',
    automaticRetryAllowed: false,
  };
}

/** One deterministic operation identity per opaque preview; the handle stays in memory. */
export async function requestKey(preview: Extract<PreviewResult, { status: 'ready_for_confirmation' }>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preview.previewHandle));
  return `request.${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function parseSeasons(value: string): number[] | undefined {
  if (!/^\s*\d+(\s*,\s*\d+)*\s*$/.test(value)) return undefined;
  const numbers = value.split(',').map(part => Number(part.trim()));
  if (numbers.length > 100 || numbers.some(number => !Number.isInteger(number) || number < 1 || number > 1000)) return undefined;
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export function previewPrompt(title: string, itemId: string, seasons?: number[]) {
  return `Preview a Moodarr request for ${JSON.stringify(title)} (item ID ${itemId})${seasons ? `, seasons ${seasons.join(', ')}` : ''}.`;
}
