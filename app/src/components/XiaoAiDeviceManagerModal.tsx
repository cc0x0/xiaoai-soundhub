/**
 * 小爱音箱设备管理面板 (XiaoAiDeviceManagerModal)
 *
 * Where XiaoAiCastModal is a picker ("which speakers get this track"), this is a
 * management view: which speaker listens for voice commands, what each one is
 * playing right now, and per-device volume / transport control.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native'
import { xiaoaiService, AuthExpiredError, type XiaoAiSpeaker } from '@/services/xiaoaiService'
import { XiaoAiAuthModal } from '@/components/XiaoAiAuthModal'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'

interface Props {
  visible: boolean
  onClose: () => void
}

/** What one speaker is playing, as reported by /api/status. */
interface NowPlaying {
  name: string
  singer: string
  source: string
}

const VOLUME_STEPS = [20, 40, 60, 80, 100]

export const XiaoAiDeviceManagerModal: React.FC<Props> = ({ visible, onClose }) => {
  const theme = useTheme()
  const [speakers, setSpeakers] = useState<XiaoAiSpeaker[]>([])
  const [playing, setPlaying] = useState<Record<string, NowPlaying>>({})
  const [loading, setLoading] = useState<boolean>(false)
  const [busyDid, setBusyDid] = useState<string>('')
  const [expandedDid, setExpandedDid] = useState<string>('')
  const [authVisible, setAuthVisible] = useState<boolean>(false)
  const [needsAuth, setNeedsAuth] = useState<boolean>(false)

  const load = useCallback(async() => {
    setNeedsAuth(false)
    setLoading(true)
    try {
      // Playback state is a nice-to-have next to the speaker list; a failure
      // there should not blank the list the user came here to manage.
      const [list, states] = await Promise.all([
        xiaoaiService.getSpeakers(),
        xiaoaiService.getStatus().catch(() => ({})),
      ])
      setSpeakers(list)
      const nowPlaying: Record<string, NowPlaying> = {}
      for (const [did, state] of Object.entries(states)) {
        if (state?.music) nowPlaying[did] = state.music
      }
      setPlaying(nowPlaying)
    } catch (err: unknown) {
      if (err instanceof AuthExpiredError) {
        setNeedsAuth(true)
        setSpeakers([])
      } else {
        toast(`加载音箱失败: ${(err as Error).message}`)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  /** Run a management action, then refresh so the panel shows the real state. */
  const runAction = async(did: string, action: () => Promise<string>) => {
    setBusyDid(did)
    try {
      const msg = await action()
      toast(msg)
      await load()
    } catch (err: unknown) {
      toast((err as Error).message)
    } finally {
      setBusyDid('')
    }
  }

  const handleSetGateway = async(did: string) => {
    await runAction(did, async() => await xiaoaiService.setGateway(did))
  }

  const handleToggleListener = async(sp: XiaoAiSpeaker) => {
    const next = sp.is_listener_enabled !== 1
    await runAction(sp.did, async() => await xiaoaiService.setSpeakerListener(sp.did, next))
  }

  const handleToggleIgnored = async(sp: XiaoAiSpeaker) => {
    const next = sp.is_ignored !== 1
    await runAction(sp.did, async() => await xiaoaiService.setSpeakerIgnored(sp.did, next))
  }

  const handleControl = async(
    did: string,
    action: 'pause' | 'resume' | 'next' | 'prev' | 'stop',
  ) => {
    setBusyDid(did)
    try {
      await xiaoaiService.control(action, [did])
      // Give the speaker a moment to actually change state before re-reading it.
      setTimeout(() => { void load() }, 900)
    } catch (err: unknown) {
      toast((err as Error).message)
    } finally {
      setBusyDid('')
    }
  }

  const handleVolume = async(did: string, volume: number) => {
    setBusyDid(did)
    try {
      await xiaoaiService.control('volume', [did], volume)
      toast(`音量已设为 ${volume}%`)
    } catch (err: unknown) {
      toast((err as Error).message)
    } finally {
      setBusyDid('')
    }
  }

  const renderSpeaker = (sp: XiaoAiSpeaker) => {
    const isGateway = sp.is_gateway === 1
    const isIgnored = sp.is_ignored === 1
    const listenerOn = sp.is_listener_enabled === 1
    const expanded = expandedDid === sp.did
    const busy = busyDid === sp.did
    const now = playing[sp.did]

    return (
      <View
        key={sp.did}
        style={[
          styles.card,
          { borderColor: isGateway ? theme['c-primary'] : theme['c-200'] },
          isIgnored && styles.cardIgnored,
        ]}
      >
        <TouchableOpacity
          style={styles.cardHeader}
          onPress={() => { setExpandedDid(expanded ? '' : sp.did) }}
        >
          <View style={styles.cardHeaderLeft}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, { color: theme['c-font'] }]} numberOfLines={1}>
                {sp.name}
              </Text>
              {isGateway && (
                <View style={[styles.badge, { backgroundColor: theme['c-primary'] }]}>
                  <Text style={styles.badgeText}>主网关</Text>
                </View>
              )}
            </View>
            <Text style={[styles.meta, { color: theme['c-font-label'] }]} numberOfLines={1}>
              {sp.model || '小爱音箱'} · {listenerOn ? '语音监听中' : '监听已暂停'}
              {isIgnored ? ' · 已屏蔽' : ''}
            </Text>
            {now && (
              <Text style={[styles.nowPlaying, { color: theme['c-primary'] }]} numberOfLines={1}>
                ♪ {now.singer} - {now.name}
              </Text>
            )}
          </View>
          {busy
            ? <ActivityIndicator size="small" color={theme['c-primary']} />
            : <Text style={[styles.chevron, { color: theme['c-font-label'] }]}>{expanded ? '▾' : '▸'}</Text>}
        </TouchableOpacity>

        {expanded && (
          <View style={[styles.cardBody, { borderTopColor: theme['c-200'] }]}>
            <View style={styles.transportRow}>
              {([
                { key: 'prev', label: '⏮' },
                { key: 'resume', label: '▶️' },
                { key: 'pause', label: '⏸' },
                { key: 'next', label: '⏭' },
                { key: 'stop', label: '⏹' },
              ] as const).map((btn) => (
                <TouchableOpacity
                  key={btn.key}
                  style={[styles.transportBtn, { backgroundColor: theme['c-200'] }]}
                  onPress={() => { void handleControl(sp.did, btn.key) }}
                  disabled={busy}
                >
                  <Text style={styles.transportLabel}>{btn.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.sectionLabel, { color: theme['c-font-label'] }]}>音量</Text>
            <View style={styles.volumeRow}>
              {VOLUME_STEPS.map((vol) => (
                <TouchableOpacity
                  key={vol}
                  style={[styles.volumeChip, { borderColor: theme['c-200'] }]}
                  onPress={() => { void handleVolume(sp.did, vol) }}
                  disabled={busy}
                >
                  <Text style={[styles.volumeText, { color: theme['c-font-label'] }]}>{vol}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.sectionLabel, { color: theme['c-font-label'] }]}>设备设置</Text>
            <View style={styles.settingRow}>
              {!isGateway && (
                <TouchableOpacity
                  style={[styles.settingBtn, { backgroundColor: theme['c-primary'] }]}
                  onPress={() => { void handleSetGateway(sp.did) }}
                  disabled={busy}
                >
                  <Text style={styles.settingBtnText}>设为主网关</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.settingBtn, { backgroundColor: theme['c-200'] }]}
                onPress={() => { void handleToggleListener(sp) }}
                disabled={busy}
              >
                <Text style={[styles.settingBtnText, { color: theme['c-font'] }]}>
                  {listenerOn ? '暂停语音监听' : '开启语音监听'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.settingBtn, { backgroundColor: theme['c-200'] }]}
                onPress={() => { void handleToggleIgnored(sp) }}
                disabled={busy}
              >
                <Text style={[styles.settingBtnText, { color: theme['c-font'] }]}>
                  {isIgnored ? '取消屏蔽' : '屏蔽此设备'}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.didText, { color: theme['c-font-label'] }]}>DID: {sp.did}</Text>
          </View>
        )}
      </View>
    )
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, { backgroundColor: theme['c-content-background'] || theme['c-100'] }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme['c-font'] }]}>🎛️ 小爱设备管理</Text>
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={() => { void load() }}>
                <Text style={[styles.linkText, { color: theme['c-primary'] }]}>刷新</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onClose}>
                <Text style={[styles.closeBtn, { color: theme['c-font-label'] }]}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={[styles.desc, { color: theme['c-font-label'] }]}>
            主网关是接收语音点歌口令的那台音箱。点开任一设备可单独控制音量与播放。
          </Text>

          {needsAuth ? (
            <View style={styles.authPrompt}>
              <Text style={[styles.emptyText, { color: theme['c-font-label'] }]}>
                设备管理需要绑定云端账号。本机播放不受影响。
              </Text>
              <TouchableOpacity
                style={[styles.bindBtn, { backgroundColor: theme['c-primary'] }]}
                onPress={() => { setAuthVisible(true) }}
              >
                <Text style={styles.bindBtnText}>立即绑定云端</Text>
              </TouchableOpacity>
            </View>
          ) : loading ? (
            <ActivityIndicator size="large" color={theme['c-primary']} style={{ marginVertical: 40 }} />
          ) : (
            <ScrollView style={styles.list}>
              {speakers.length === 0
                ? (
                    <Text style={[styles.emptyText, { color: theme['c-font-label'] }]}>
                      未发现音箱。请在云端控制台绑定小米账号后重试。
                    </Text>
                  )
                : speakers.map(renderSpeaker)}
            </ScrollView>
          )}
        </View>
      </View>

      <XiaoAiAuthModal
        visible={authVisible}
        onClose={() => { setAuthVisible(false) }}
        onAuthorized={() => { void load() }}
        purpose="设备管理需要绑定云端账号，才能读取与切换音箱设置。"
      />
    </Modal>
  )
}

const styles = createStyle({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  container: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  linkText: {
    fontSize: 13,
    fontWeight: 'bold',
    marginRight: 14,
  },
  closeBtn: {
    fontSize: 20,
    padding: 4,
  },
  desc: {
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 12,
  },
  list: {
    maxHeight: 460,
  },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 10,
    overflow: 'hidden',
  },
  cardIgnored: {
    opacity: 0.5,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  cardHeaderLeft: {
    flex: 1,
    paddingRight: 10,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  meta: {
    fontSize: 11,
    marginTop: 3,
  },
  nowPlaying: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
  },
  chevron: {
    fontSize: 14,
  },
  cardBody: {
    borderTopWidth: 1,
    padding: 12,
  },
  transportRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  transportBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
    marginHorizontal: 3,
  },
  transportLabel: {
    fontSize: 15,
  },
  sectionLabel: {
    fontSize: 11,
    marginTop: 12,
    marginBottom: 6,
  },
  volumeRow: {
    flexDirection: 'row',
  },
  volumeChip: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
    marginRight: 6,
  },
  volumeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  settingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  settingBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 8,
    marginBottom: 6,
  },
  settingBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  didText: {
    fontSize: 10,
    marginTop: 8,
  },
  authPrompt: {
    paddingVertical: 10,
  },
  bindBtn: {
    padding: 13,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  bindBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  emptyText: {
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 19,
    marginVertical: 20,
  },
})
