/**
 * KiroAdapter - Kiro CLI (ACP) implementation of the generic provider adapter contract.
 *
 * This service owns the `kiro-cli acp` child process and JSON-RPC 2.0 over
 * stdio semantics, emitting canonical provider runtime events. It does not
 * perform cross-provider routing or checkpoint orchestration.
 *
 * @module KiroAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kiro";
}

export class KiroAdapter extends Context.Service<KiroAdapter, KiroAdapterShape>()(
  "t3/provider/Services/KiroAdapter",
) {}
