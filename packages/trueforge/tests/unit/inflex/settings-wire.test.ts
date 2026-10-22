import { InflexSettingsSchema } from '@truefoundry/trueforge-core/core';
import { serialization } from '@truefoundry/trueforge-sdk';
const { RuntimeConfig } = serialization;

it('preserves goal and thinking settings through the existing generated SDK wire serializer', () => {
  const configuration = {
    iterationLimit: 128,
    inflex: InflexSettingsSchema.parse({ goal_mode: 'enhanced', thinking_tier: 'ultra', workspace: '/project' }),
  };
  const wire = RuntimeConfig.jsonOrThrow(configuration, { unrecognizedObjectKeys: 'passthrough' });
  expect(wire).toHaveProperty('iteration_limit', 128);
  expect(wire).toHaveProperty('inflex', { goal_mode: 'enhanced', thinking_tier: 'ultra', workspace: '/project' });
  expect(RuntimeConfig.parseOrThrow(wire, { unrecognizedObjectKeys: 'passthrough' })).toHaveProperty(
    'inflex',
    configuration.inflex,
  );
});
