import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { openaiCodexProvider } from '../../node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js';
import { getBuiltinModelDataGeneratedAt } from '../../node_modules/@earendil-works/pi-ai/dist/providers/all.js';
import { withRemoteCatalog } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/remote-catalog-provider.js';

// Temporary bundled fallback until the native Pi catalog provides Terra.
// Keep the provider's ordinary OAuth, user config and remote catalog behavior.
const terra = {
 id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', provider: 'openai-codex',
 api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api',
 reasoning: true, input: ['text', 'image'],
 thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
 cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
 contextWindow: 500000, maxTokens: 128000,
 compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
};

export default function registerTerra(pi: ExtensionAPI) {
 const base = withRemoteCatalog(openaiCodexProvider(), undefined, getBuiltinModelDataGeneratedAt());
 const includeTerra = (models: any[]) => models.some(model => model.id === terra.id && (!model.type || model.type === 'chat'))
  ? models : [...models, terra];
 pi.registerProvider({ ...base,
  getModels: () => includeTerra(base.getModels()),
  getAllModels: () => includeTerra(base.getAllModels()),
 } as any);
}
