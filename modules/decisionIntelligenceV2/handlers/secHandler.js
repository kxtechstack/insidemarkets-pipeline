  // If SEC fired a framework response, SEC chunks MUST reach the decision
  // handler (inference ignores them). Force decision dispatch regardless
  // of the router's `type`.
  const isFrameworkFromSec = secInjectChunks.length > 0;

  if (routerResult.type === 'inference' && !isFrameworkFromSec) {
    const handlerResult = await buildInferenceAnswer(question, keptClient, keptCustom);
    const payload = await buildInferenceResponse({ handlerResult, clientId });
    return { routerResult, handlerResult, payload };
  }

  // decision — SEC chunks merged in (empty array if SEC didn't fire)
  const handlerResult = await buildDecisionAnswer(question, keptClientWithSec, keptCustom);
  const payload = await buildDecisionResponse({ handlerResult, clientId });
  return { routerResult, handlerResult, payload };