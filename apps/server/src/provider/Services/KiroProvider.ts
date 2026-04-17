import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface KiroProviderShape extends ServerProviderShape {}

export class KiroProvider extends Context.Service<KiroProvider, KiroProviderShape>()(
  "t3/provider/Services/KiroProvider",
) {}
