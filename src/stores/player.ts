import { defineStore } from 'pinia'
import { ref, computed, nextTick } from 'vue'
import type { RadioStation, PlayerState, FavoriteStation } from '@/types/radio'
import { useHistoryStore } from './history'
import { mediaSessionManager } from '@/utils/mediaSession'
import { deviceOptimization } from '@/utils/deviceOptimization'
// MediaControl插件已移除
import Hls from 'hls.js'
import { Capacitor } from '@capacitor/core'
import { MediaSession } from '@jofr/capacitor-media-session'

export const usePlayerStore = defineStore('player', () => {
  // 状态
  const audio = ref<HTMLAudioElement | null>(null)
  const currentStation = ref<RadioStation | null>(null)
  const isPlaying = ref(false)
  const isLoading = ref(false)
  const volume = ref(0.8)
  const isMuted = ref(false)
  const error = ref<string | null>(null)
  const favorites = ref<FavoriteStation[]>([])
  const playFailureCallback = ref<((station: RadioStation) => void) | null>(null)
  const sleepTimer = ref<number | null>(null)
  const sleepTimerEnd = ref<number>(0)
  const sleepTimerInterval = ref<NodeJS.Timeout | null>(null)
  const originalVolume = ref(0.8)
  const isDucked = ref(false)

  // 计算属性
  const playerState = computed<PlayerState>(() => ({
    isPlaying: isPlaying.value,
    currentStation: currentStation.value,
    volume: volume.value,
    isMuted: isMuted.value,
    isLoading: isLoading.value,
    error: error.value
  }))

  const hls = ref<Hls | null>(null)

  const destroyHls = () => {
    if (hls.value) {
      hls.value.destroy()
      hls.value = null
    }
  }

  // m3u8 直播流：Chrome 桌面原生播不了，用 hls.js 走 MSE；Safari 原生支持 HLS，走原生
  const isHlsUrl = (url: string) => url.split('?')[0].toLowerCase().endsWith('.m3u8')
  const attachSource = async (url: string): Promise<void> => {
    destroyHls()
    if (isHlsUrl(url) && Hls.isSupported()) {
      // 注意：部分央媒 m3u8（如 CNR ngcdn）只放行自家域名的跨域请求，hls.js 在 Chrome 里会被 CORS 拦住；
      // 10 秒等不到清单就改走原生播放（Safari 原生支持 HLS 能播，Chrome 播不了会走重试并报播放失败，不再静默卡死）
      try {
        await new Promise<void>((resolve, reject) => {
          const instance = new Hls({ maxBufferLength: 30 })
          hls.value = instance
          const timer = setTimeout(() => reject(new Error('hls: manifest timeout')), 10000)
          instance.loadSource(url)
          instance.attachMedia(audio.value!)
          instance.on(Hls.Events.MANIFEST_PARSED, () => {
            clearTimeout(timer)
            resolve()
          })
          instance.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              clearTimeout(timer)
              reject(new Error(`hls: ${data.type}/${data.details}`))
            }
          })
        })
        return
      } catch (e) {
        destroyHls()
        // Chrome 桌面原生播不了 m3u8，再走原生只会无声卡死：直接报失败，让重试/报错逻辑接管
        if (!audio.value!.canPlayType('application/vnd.apple.mpegurl')) {
          throw e
        }
        console.warn('hls 播放失败，改走原生播放:', e)
      }
    }
    audio.value!.src = url
    audio.value!.load()
  }

  const isFavorite = computed(() => {
    if (!currentStation.value) return false
    return favorites.value.some(fav => fav.stationuuid === currentStation.value!.stationuuid)
  })

  const sleepTimerRemaining = computed(() => sleepTimer.value || 0)
  const hasSleepTimer = computed(() => sleepTimer.value !== null && sleepTimer.value > 0)

  // 初始化音频元素
  const initAudio = () => {
    if (!audio.value) {
      audio.value = new Audio()
      audio.value.preload = 'none'
      
      // 设置音频属性以优化播放
      audio.value.volume = volume.value
      audio.value.muted = isMuted.value
      
      // 优化移动设备播放
      if (deviceOptimization.isMobile()) {
        audio.value.setAttribute('playsinline', 'true')
        audio.value.setAttribute('webkit-playsinline', 'true')
      }
      
      // 音频事件监听
      audio.value.addEventListener('loadstart', () => {
        isLoading.value = true
      })
      
      audio.value.addEventListener('canplay', () => {
        isLoading.value = false
      })
      
      audio.value.addEventListener('play', () => {
        isPlaying.value = true
        isLoading.value = false
        error.value = null
        deviceOptimization.optimizeAudioElement(audio.value!)
        deviceOptimization.requestWakeLock()
        // 媒体控制已移除
      })
      
      audio.value.addEventListener('pause', () => {
        isPlaying.value = false
        // 媒体控制已移除
      })
      
      audio.value.addEventListener('ended', () => {
        isPlaying.value = false
        // 媒体控制已移除
      })
      
      audio.value.addEventListener('error', (e) => {
        console.error('音频播放错误:', e)
        isPlaying.value = false
        isLoading.value = false
        // 媒体控制已移除
      })
      
      audio.value.addEventListener('stalled', () => {
        // 只在正在播放时重载；起播阶段卡住由 playStation 的超时接管，避免对播不了的 m3u8 无限 load 循环
        if (audio.value && currentStation.value && isPlaying.value) {
          console.log('音频加载停滞，尝试重新加载...')
          audio.value.load()
        }
      })
      
      audio.value.addEventListener('waiting', () => {
        isLoading.value = true
      })
      
      audio.value.addEventListener('playing', () => {
        isLoading.value = false
      })
    }
  }

  // 设置媒体会话事件监听器
  const setupMediaSessionHandlers = async () => {
    // 移除PC端前后台切换音量变化功能
    // 仅保留原生应用的媒体会话处理
    
    // 如果是Capacitor平台，设置媒体会话插件
    if (Capacitor.isNativePlatform()) {
      try {
        // 设置媒体会话动作处理器
        await MediaSession.setActionHandler({ action: 'play' }, () => {
          if (currentStation.value) {
            resumeStation()
          }
        })
        
        await MediaSession.setActionHandler({ action: 'pause' }, () => {
          pauseStation()
        })
        
        await MediaSession.setActionHandler({ action: 'stop' }, () => {
          stopStation()
        })
        
        console.log('媒体会话处理器已设置')
      } catch (error) {
        console.error('设置媒体会话处理器失败:', error)
      }
    }
    
    // Web平台的媒体会话事件
    window.addEventListener('mediaSession:play', () => {
      if (currentStation.value) {
        resumeStation()
      }
    })

    window.addEventListener('mediaSession:pause', () => {
      pauseStation()
    })

    window.addEventListener('mediaSession:stop', () => {
      stopStation()
    })
  }

  // 添加到播放历史 - 需要在playStation之前定义
  const addToHistory = (station: RadioStation) => {
    const historyStore = useHistoryStore()
    historyStore.addToHistory(station)
  }

  // 播放电台
  const playStation = async (station: RadioStation, retryCount = 0): Promise<void> => {
    const maxRetries = 2
    
    try {
      console.log(`尝试播放电台: ${station.name} (重试次数: ${retryCount})`)
      
      if (!audio.value) {
        initAudio()
      }
      
      // 清除之前的错误
      error.value = null
      isLoading.value = true
      
      // 如果正在播放其他电台，先停止
      if (currentStation.value && currentStation.value.stationuuid !== station.stationuuid) {
        audio.value!.pause()
        await nextTick()
      }
      
      // 设置新的电台
      currentStation.value = station
      addToHistory(station)
      
      // 原生播放器代码已移除，直接使用Web播放器
      
      // 设置音频源（m3u8 走 hls.js，其余走原生）
      await attachSource(station.url_resolved || station.url)
      audio.value!.volume = isDucked.value ? volume.value * 0.3 : volume.value
      audio.value!.muted = isMuted.value

      // play() 在播不了的流上可能一直不返回：15 秒没出声就当失败，不再无声卡死
      await Promise.race([
        audio.value!.play(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('播放超时，请稍后重试')), 15000)
        )
      ])
      
      console.log(`成功播放电台: ${station.name}`)
      
      // 媒体控制代码已移除
      
    } catch (playError) {
      console.error(`播放重试 (重试 ${retryCount}/${maxRetries}):`, playError)
      
      if (retryCount < maxRetries) {
        // 重试播放
        console.log(`${retryCount + 1}秒后重试播放...`)
        await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 1000))
        return await playStation(station, retryCount + 1)
      } else {
        // 达到最大重试次数
        error.value = '播放失败，请稍后重试'
        isPlaying.value = false
        isLoading.value = false
        throw new Error(error.value)
      }
    }
  }

  // 暂停播放
  const pauseStation = async () => {
    if (audio.value) {
      audio.value.pause()
    }
  }

  // 恢复播放
  const resumeStation = async () => {
    if (audio.value && currentStation.value) {
      try {
        await audio.value.play()
      } catch (err) {
        console.error('恢复播放失败')
        console.error('恢复播放错误:', err)
      }
    }
  }

  // 停止播放
  const stopStation = async () => {
    destroyHls()
    if (audio.value) {
      audio.value.pause()
      audio.value.currentTime = 0
    }
    isPlaying.value = false
    currentStation.value = null
    mediaSessionManager.clear()
    
    // 停止播放时释放唤醒锁
    deviceOptimization.releaseWakeLock()
  }

  // 设置音量
  const setVolume = (newVolume: number) => {
    volume.value = Math.max(0, Math.min(1, newVolume))
    originalVolume.value = volume.value
    
    if (audio.value) {
      audio.value.volume = isDucked.value ? volume.value * 0.3 : volume.value
    }
    
    // 保存到本地存储
    localStorage.setItem('radio-volume', volume.value.toString())
  }

  // 切换静音
  const toggleMute = () => {
    isMuted.value = !isMuted.value
    if (audio.value) {
      audio.value.muted = isMuted.value
    }
    
    // 保存到本地存储
    localStorage.setItem('radio-muted', isMuted.value.toString())
  }

  // 添加到收藏夹
  const addToFavorites = (station: RadioStation) => {
    const favorite: FavoriteStation = {
      stationuuid: station.stationuuid,
      name: station.name,
      url: station.url,
      favicon: station.favicon,
      country: station.country,
      addedAt: new Date().toISOString()
    }
    
    if (!favorites.value.some(fav => fav.stationuuid === station.stationuuid)) {
      favorites.value.unshift(favorite)
      saveFavorites()
    }
  }

  // 从收藏夹移除
  const removeFromFavorites = (stationUuid: string) => {
    const index = favorites.value.findIndex(fav => fav.stationuuid === stationUuid)
    if (index > -1) {
      favorites.value.splice(index, 1)
      saveFavorites()
    }
  }

  // 移除收藏（别名方法）
  const removeFavorite = (stationUuid: string) => {
    removeFromFavorites(stationUuid)
  }

  // 清空收藏夹
  const clearFavorites = () => {
    favorites.value = []
    saveFavorites()
  }

  // 检查特定电台是否被收藏
  const isStationFavorite = (stationUuid: string) => {
    return favorites.value.some(fav => fav.stationuuid === stationUuid)
  }

  // 切换收藏状态
  const toggleFavorite = (station: RadioStation) => {
    if (isStationFavorite(station.stationuuid)) {
      removeFromFavorites(station.stationuuid)
    } else {
      addToFavorites(station)
    }
  }

  // 保存收藏夹到本地存储
  const saveFavorites = () => {
    localStorage.setItem('radio-favorites', JSON.stringify(favorites.value))
  }

  // 从本地存储加载收藏夹
  const loadFavorites = () => {
    try {
      const saved = localStorage.getItem('radio-favorites')
      if (saved) {
        favorites.value = JSON.parse(saved)
      }
    } catch (err) {
      console.error('加载收藏夹失败:', err)
    }
  }

  // 清除错误
  const clearError = () => {
    error.value = null
  }

  // 设置播放失败回调
  const setPlayFailureCallback = (callback: ((station: RadioStation) => void) | null) => {
    playFailureCallback.value = callback
  }

  // 设置睡眠定时器
  const setSleepTimer = (minutes: number) => {
    sleepTimer.value = minutes
    
    if (sleepTimerInterval.value) {
      clearInterval(sleepTimerInterval.value)
    }
    
    sleepTimerInterval.value = setInterval(() => {
      if (sleepTimer.value && sleepTimer.value > 0) {
        sleepTimer.value--
        
        if (sleepTimer.value === 0) {
          clearSleepTimer()
          stopStation()
        }
      }
    }, 60000) // 每分钟减1
  }

  // 清除睡眠定时器
  const clearSleepTimer = () => {
    sleepTimer.value = null
    
    if (sleepTimerInterval.value) {
      clearInterval(sleepTimerInterval.value)
      sleepTimerInterval.value = null
    }
  }

  // 从本地存储恢复状态
  const restoreFromStorage = () => {
    try {
      const savedVolume = localStorage.getItem('radio-volume')
      if (savedVolume) {
        volume.value = parseFloat(savedVolume)
        originalVolume.value = volume.value
      }
      
      const savedMuted = localStorage.getItem('radio-muted')
      if (savedMuted) {
        isMuted.value = savedMuted === 'true'
      }
      
      const savedFavorites = localStorage.getItem('radio-favorites')
      if (savedFavorites) {
        favorites.value = JSON.parse(savedFavorites)
      }
    } catch (error) {
      console.error('从本地存储恢复状态失败:', error)
    }
  }

  // 初始化
  loadFavorites()
  setupMediaSessionHandlers()
  
  // 移动设备优化提示
  if (deviceOptimization.isMobile()) {
    deviceOptimization.suggestBatteryOptimization()
  }

  return {
    // 状态
    audio,
    currentStation,
    isPlaying,
    isLoading,
    volume,
    isMuted,
    error,
    favorites,
    sleepTimer,
    sleepTimerEnd,
    
    // 计算属性
    playerState,
    isFavorite,
    sleepTimerRemaining,
    hasSleepTimer,
    
    // 方法
    playStation,
    pauseStation,
    resumeStation,
    stopStation,
    setVolume,
    toggleMute,
    addToFavorites,
    removeFromFavorites,
    removeFavorite,
    toggleFavorite,
    isStationFavorite,
    clearFavorites,
    clearError,
    setPlayFailureCallback,
    setSleepTimer,
    clearSleepTimer,
    addToHistory,
    restoreFromStorage,
  }
})
