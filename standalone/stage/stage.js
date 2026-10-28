(() => {
  'use strict'

  const motions = new Set(['idle', 'aidale', 'selfie', 'selfieQuick', 'ketchup', 'openLid', 'bubble', 'splash'])
  // Identifiers are the keys of assets/model/manifest.json expressions.
  const expressions = Object.freeze([
    'love', '兔兔贴纸', '单边马尾', '双手比耶', '吐舌', '吐魂', '呆呆眼', '哭',
    '喵喵手~喵~动画', '圆眼镜', '墨镜', '头箍', '巴菲', '开心兴奋', '心跳', '悲伤',
    '情绪花花', '感叹号', '手机换色', '挤', '撤回', '方眼镜', '星星眼', '晕晕',
    '椭圆眼镜', '橡皮', '流汗', '深色桌布', '点菜按下', '爱心眼', '猫猫贴纸',
    '生气', '画笔', '脸红', '蛋包饭', '蝴蝶结贴纸', '调皮', '闭眼口水', '问号',
    '阴暗', '魔爪', '魔爪换色', '鲸鱼', '鲸鱼放桌上',
  ])
  const expressionNames = new Set(expressions)
  const bubble = document.getElementById('bubble')
  const stage = document.getElementById('stage')
  const queue = []
  const bubbleDuration = 5000
  const bubbleMaxAge = 30000
  const bubbleQueueLimit = 10
  const textMaxLength = 500
  let bubbleTimer
  let currentExpression = null
  let motionQueue = Promise.resolve()

  function showNextBubble() {
    bubbleTimer = undefined
    const now = Date.now()
    while (queue.length && now - queue[0].receivedAt >= bubbleMaxAge) queue.shift()
    const next = queue.shift()
    bubble.textContent = next ? next.text : ''
    bubble.hidden = !next
    if (next) bubbleTimer = setTimeout(showNextBubble, bubbleDuration)
  }

  function showText(text) {
    if (!text) {
      clearTimeout(bubbleTimer)
      bubbleTimer = undefined
      queue.length = 0
      bubble.textContent = ''
      bubble.hidden = true
      return
    }
    if (queue.length === bubbleQueueLimit) queue.shift()
    queue.push({ text, receivedAt: Date.now() })
    if (bubbleTimer === undefined) showNextBubble()
  }

  function perform(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'performance') return false
    if (event.text !== undefined && (typeof event.text !== 'string' ||
        event.text.length > textMaxLength * 2 || [...event.text].length > textMaxLength)) return false
    if (event.motion != null && (typeof event.motion !== 'string' || !motions.has(event.motion))) return false
    if (event.expression !== undefined && event.expression !== null &&
        (typeof event.expression !== 'string' || !expressionNames.has(event.expression))) return false
    if (event.text === undefined && event.motion === undefined && event.expression === undefined) return false

    if (event.text !== undefined) showText(event.text)
    if (event.expression !== undefined) currentExpression = event.expression
    if (event.motion != null) {
      motionQueue = motionQueue.then(async () => {
        const loaded = await modelReady
        const started = await loaded.motion(event.motion, 0, 3)
        if (!started) console.error('[stage] 动作未能开始:', event.motion)
      }).catch(error => console.error('[stage] 动作播放失败:', error))
    }
    return true
  }

  window.whaleStage = Object.freeze({ perform, expressions })

  const modelReady = (async () => {
    const app = new PIXI.Application({
      width: window.innerWidth, height: window.innerHeight,
      backgroundAlpha: 0, antialias: true, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
    })
    app.ticker.maxFPS = 30
    stage.appendChild(app.view)
    const { Live2DModel } = PIXI.live2d
    Live2DModel.registerTicker(PIXI.Ticker)
    const model = await Live2DModel.from('/assets/model/c_0120.model3.json', {
      autoInteract: false, autoUpdate: true, idleMotionGroup: 'idle',
    })
    model.eventMode = 'none'
    app.stage.addChild(model)
    function resize() {
      const width = window.innerWidth
      const height = window.innerHeight
      app.renderer.resize(width, height)
      const internal = model.internalModel
      const baseWidth = internal.width || internal.originalWidth
      const baseHeight = internal.height || internal.originalHeight
      if (!(baseWidth > 0 && baseHeight > 0)) throw new Error('模型尺寸无效')
      const scale = Math.min(width * 0.9 / baseWidth, height * 0.72 / baseHeight)
      model.scale.set(scale)
      model.position.set((width - baseWidth * scale) / 2, height - baseHeight * scale)
    }
    resize()
    window.addEventListener('resize', resize)
    return model
  })()
  modelReady.catch(error => console.error('[stage] 模型加载失败:', error))

  async function loadJson(url) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`加载 ${url} 失败: ${response.status}`)
    return response.json()
  }

  Promise.all([
    modelReady, loadJson('/assets/model/manifest.json'), loadJson('/assets/model/c_0120.cdi3.json'),
  ]).then(([model, manifest, cdi]) => {
    const ids = new Set(cdi.Parameters.map(parameter => parameter.Id))
    const params = new Map(expressions.map(name => {
      const entry = manifest.expressions[name]
      if (!entry || !Array.isArray(entry.params) || entry.params.some(p => p.blend !== 'Add')) {
        throw new Error(`表情定义无效: ${name}`)
      }
      const usable = entry.params.filter(p => ids.has(p.id))
      if (!usable.length) throw new Error(`表情没有可用参数: ${name}`)
      return [name, usable]
    }))
    model.internalModel.on('beforeModelUpdate', () => {
      if (currentExpression === null) return
      for (const parameter of params.get(currentExpression)) {
        model.internalModel.coreModel.addParameterValueById(parameter.id, parameter.value)
      }
    })
  }).catch(error => console.error('[stage] 表情初始化失败:', error))

  const token = new URLSearchParams(window.location.search).get('token')
  if (token !== null) {
    const source = new EventSource('/events?' + new URLSearchParams({ token }))
    source.onmessage = message => {
      try {
        if (!perform(JSON.parse(message.data))) console.warn('[stage] 忽略无效表演事件')
      } catch (error) {
        console.warn('[stage] 忽略无效 SSE 数据:', error)
      }
    }
    source.onerror = () => console.warn('[stage] SSE 连接中断，浏览器将自动重连')
  } else {
    console.warn('[stage] URL 缺少 token，未连接 SSE')
  }
})()
