/**
 * 默认 AI 配置常量
 *
 * 新用户注册或系统初始化时使用的智谱 GLM 默认配置
 */

export const DEFAULT_AI_CONFIG = JSON.stringify({
  providers: [
    {
      id: 'zhipu_glm',
      name: '智谱GLM',
      isBuiltIn: true,
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      textModel: 'glm-4-flash',
      visionModel: 'glm-4v-flash',
      audioModel: 'glm-4-voice'
    }
  ],
  binding: {
    textProviderId: 'zhipu_glm',
    visionProviderId: 'zhipu_glm',
    speechProviderId: 'zhipu_glm'
  },
  strategy: 'cloud_first',
  custom_prompt: ''
});
