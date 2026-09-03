import { memo, useState, useEffect, useCallback } from 'react'
import { View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native'
import Section from '../../components/Section'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import {
  xiaoaiService,
  DEFAULT_SERVER_URL,
  AuthExpiredError,
  type XiaoAiDevice,
  type XiaoAiUserSettings,
} from '@/services/xiaoaiService'
import { XiaoAiTTSModal } from '@/components/XiaoAiTTSModal'
import { XiaoAiCastModal } from '@/components/XiaoAiCastModal'
import { XiaoAiDeviceManagerModal } from '@/components/XiaoAiDeviceManagerModal'
import { XiaoAiAuthModal } from '@/components/XiaoAiAuthModal'

/** Search sources, matching the server's platform ids. */
const SOURCE_OPTIONS = [
  { value: 'all', label: '聚合' },
  { value: 'kw', label: '酷我' },
  { value: 'tx', label: 'QQ' },
  { value: 'kg', label: '酷狗' },
  { value: 'mg', label: '咪咕' },
  { value: 'wy', label: '网易云' },
] as const

const QUALITY_OPTIONS = [
  { value: '128k', label: '128k' },
  { value: '320k', label: '320k' },
  { value: 'flac', label: 'FLAC' },
] as const

const CHIME_OPTIONS = [
  { value: 'dingdong', label: '🔔 叮咚' },
  { value: 'gentle', label: '✨ 和弦' },
  { value: 'marimba', label: '💧 水滴' },
  { value: 'none', label: '🚫 无' },
] as const

const POLICY_OPTIONS = [
  { value: 'cross_source', label: '自动兜底' },
  { value: 'strict', label: '严格提示' },
] as const

export default memo(() => {
  const theme = useTheme()
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [token, setToken] = useState('')
  const [devices, setDevices] = useState<XiaoAiDevice[]>([])
  const [testing, setTesting] = useState(false)
  const [ttsModalVisible, setTtsModalVisible] = useState(false)
  const [castModalVisible, setCastModalVisible] = useState(false)
  const [deviceModalVisible, setDeviceModalVisible] = useState(false)
  const [authModalVisible, setAuthModalVisible] = useState(false)
  const [settings, setSettings] = useState<XiaoAiUserSettings | null>(null)
  const [syncing, setSyncing] = useState(false)

  /** Pull the tenant's cloud preferences so both ends show the same values. */
  const loadCloudSettings = useCallback(async() => {
    try {
      setSettings(await xiaoaiService.getSettings())
    } catch {
      // Not fatal: the panel still works for the local-only fields.
      setSettings(null)
    }
  }, [])

  useEffect(() => {
    setServerUrl(xiaoaiService.getServerUrl() || DEFAULT_SERVER_URL)
    setToken(xiaoaiService.getToken() || '')
    void loadCloudSettings()
  }, [loadCloudSettings])

  const handleSaveUrl = (url: string) => {
    setServerUrl(url)
    void xiaoaiService.setServerUrl(url)
  }

  const handleSaveToken = (t: string) => {
    setToken(t)
    void xiaoaiService.setToken(t)
  }

  const handleTestConnect = async() => {
    if (!serverUrl) {
      toast('请输入云端服务地址')
      return
    }
    setTesting(true)
    try {
      await xiaoaiService.setServerUrl(serverUrl)
      await xiaoaiService.setToken(token)
      const list = await xiaoaiService.getDevices(true)
      setDevices(list)
      toast(`连接成功！发现 ${list.length} 台小爱音箱 🎉`)
      await loadCloudSettings()
    } catch (err: unknown) {
      toast(`连接失败: ${(err as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  /**
   * Push one preference upward, then re-read from the server.
   * Optimistically updating the local state first keeps the taps responsive; the
   * re-read is what makes the panel agree with the cloud if the write was
   * rejected or normalized server-side.
   */
  const patchSetting = async(patch: Partial<XiaoAiUserSettings>) => {
    if (!xiaoaiService.hasToken()) {
      setAuthModalVisible(true)
      return
    }
    const previous = settings
    setSettings(previous ? { ...previous, ...patch } : null)
    setSyncing(true)
    try {
      await xiaoaiService.updateSettings(patch)
      setSettings(await xiaoaiService.getSettings())
    } catch (err: unknown) {
      setSettings(previous)
      if (err instanceof AuthExpiredError) {
        setToken('')
        setSettings(null)
        setAuthModalVisible(true)
      } else {
        toast(`同步失败: ${(err as Error).message}`)
      }
    } finally {
      setSyncing(false)
    }
  }

  const renderChoiceRow = <T extends string>(
    label: string,
    options: ReadonlyArray<{ value: T, label: string }>,
    current: string,
    onPick: (value: T) => void,
  ) => (
    <View style={styles.choiceBlock}>
      <Text style={styles.choiceLabel} size={13}>{label}</Text>
      <View style={styles.choiceRow}>
        {options.map((opt) => {
          const active = current === opt.value
          return (
            <TouchableOpacity
              key={opt.value}
              style={[
                styles.choiceChip,
                { borderColor: active ? theme['c-primary'] : theme['c-300'] ?? theme['c-200'] },
                active && { backgroundColor: `${theme['c-primary']}20` },
              ]}
              onPress={() => { onPick(opt.value) }}
              disabled={syncing}
            >
              <Text
                size={12}
                color={active ? theme['c-primary'] : theme['c-font-label']}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          )
        })}
      </View>
    </View>
    )

  return (
    <Section title="小爱声枢 (XiaoAi SoundHub) 服务">
      <View style={styles.container}>
        <Text style={styles.label} size={14}>云端服务地址 (支持公网 IP 或域名)</Text>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: theme['c-200'],
              color: theme['c-font'],
              borderColor: theme['c-300'] ?? theme['c-200'],
            },
          ]}
          value={serverUrl}
          placeholder="例如：http://123.45.67.89:8989"
          placeholderTextColor={theme['c-font-label']}
          onChangeText={handleSaveUrl}
        />

        <Text style={[styles.label, { marginTop: 12 }]} size={14}>服务访问 Token (未开启鉴权可留空)</Text>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: theme['c-200'],
              color: theme['c-font'],
              borderColor: theme['c-300'] ?? theme['c-200'],
            },
          ]}
          value={token}
          placeholder="可选填鉴权 Token"
          placeholderTextColor={theme['c-font-label']}
          onChangeText={handleSaveToken}
        />

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: theme['c-primary'] }]}
            onPress={handleTestConnect}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>🔄 测试连接并拉取音箱</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.quickActions}>
          <TouchableOpacity
            style={[styles.actionChip, { backgroundColor: theme['c-200'] }]}
            onPress={() => { setTtsModalVisible(true) }}
          >
            <Text style={styles.actionChipText}>📢 全屋 TTS 语音广播</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionChip, { backgroundColor: theme['c-200'] }]}
            onPress={() => { setCastModalVisible(true) }}
          >
            <Text style={styles.actionChipText}>🔊 投播面板</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.wideChip, { backgroundColor: theme['c-200'] }]}
          onPress={() => { setDeviceModalVisible(true) }}
        >
          <Text style={styles.actionChipText}>🎛️ 设备管理（主网关 / 音量 / 单机控制）</Text>
        </TouchableOpacity>

        {/* 云端偏好双向同步：未绑定时收起，避免展示一堆无法保存的开关 */}
        {xiaoaiService.hasToken()
          ? (
              <View style={styles.cloudSection}>
                <View style={styles.cloudHeader}>
                  <Text style={styles.deviceHeader} size={13}>云端偏好（与 Web 控制台实时同步）</Text>
                  {syncing && <ActivityIndicator size="small" color={theme['c-primary']} />}
                </View>

                {settings
                  ? (
                      <>
                        {renderChoiceRow('默认搜索音源', SOURCE_OPTIONS, settings.search_platform,
                          (v) => { void patchSetting({ search_platform: v }) })}
                        {renderChoiceRow('首选音质', QUALITY_OPTIONS, settings.preferred_quality,
                          (v) => { void patchSetting({ preferred_quality: v }) })}
                        {renderChoiceRow('播报提示音', CHIME_OPTIONS, settings.default_chime,
                          (v) => {
                            void patchSetting({ default_chime: v, enable_tts_chime: v === 'none' ? 0 : 1 })
                          })}
                        {renderChoiceRow('取不到直链时', POLICY_OPTIONS, settings.fallback_policy,
                          (v) => { void patchSetting({ fallback_policy: v }) })}
                        <Text style={styles.policyHint} size={11} color={theme['c-font-label']}>
                          自动兜底会严格比对同歌名、同歌手、时长相差 8 秒内的录音；严格提示则会告知具体原因，
                          例如某平台需要先配置账号凭证。
                        </Text>
                      </>
                    )
                  : (
                      <TouchableOpacity
                        style={[styles.wideChip, { backgroundColor: theme['c-200'], marginTop: 8 }]}
                        onPress={() => { void loadCloudSettings() }}
                      >
                        <Text style={styles.actionChipText}>云端偏好读取失败，点此重试</Text>
                      </TouchableOpacity>
                    )}
              </View>
            )
          : (
              <TouchableOpacity
                style={[styles.wideChip, { backgroundColor: theme['c-primary'], marginTop: 12 }]}
                onPress={() => { setAuthModalVisible(true) }}
              >
                <Text style={[styles.actionChipText, { color: '#fff' }]}>
                  🔑 绑定云端账号以同步偏好与投播
                </Text>
              </TouchableOpacity>
            )}

        {devices.length > 0 && (
          <View style={styles.deviceCard}>
            <Text style={styles.deviceHeader} size={13}>已连接音箱设备 ({devices.length})：</Text>
            <ScrollView style={{ maxHeight: 120 }}>
              {devices.map((dev) => (
                <View key={dev.did} style={styles.deviceItem}>
                  <Text size={13}>• {dev.name} ({dev.model || '小爱音箱'})</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      <XiaoAiTTSModal visible={ttsModalVisible} onClose={() => { setTtsModalVisible(false) }} />
      <XiaoAiCastModal visible={castModalVisible} onClose={() => { setCastModalVisible(false) }} />
      <XiaoAiDeviceManagerModal
        visible={deviceModalVisible}
        onClose={() => { setDeviceModalVisible(false) }}
      />
      <XiaoAiAuthModal
        visible={authModalVisible}
        onClose={() => { setAuthModalVisible(false) }}
        onAuthorized={() => {
          setToken(xiaoaiService.getToken())
          void loadCloudSettings()
        }}
      />
    </Section>
  )
})

const styles = createStyle({
  container: {
    paddingVertical: 10,
  },
  label: {
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  buttonRow: {
    marginTop: 14,
  },
  btn: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  actionChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  actionChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  wideChip: {
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  cloudSection: {
    marginTop: 16,
  },
  cloudHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  choiceBlock: {
    marginTop: 10,
  },
  choiceLabel: {
    marginBottom: 6,
  },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  choiceChip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginRight: 6,
    marginBottom: 6,
  },
  policyHint: {
    marginTop: 8,
    lineHeight: 16,
  },
  deviceCard: {
    marginTop: 14,
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  deviceHeader: {
    fontWeight: 'bold',
    marginBottom: 6,
  },
  deviceItem: {
    paddingVertical: 3,
  },
})

