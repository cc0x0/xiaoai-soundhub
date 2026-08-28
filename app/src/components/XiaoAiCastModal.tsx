/**
 * 小爱音箱投播选择器弹窗 (XiaoAiCastModal)
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
  Alert,
  Platform,
} from 'react-native'
import { xiaoaiService, type XiaoAiDevice, type CastMusicParams } from '@/services/xiaoaiService'
import { useTheme } from '@/store/theme/hook'

interface Props {
  visible: boolean
  onClose: () => void
  currentMusic?: CastMusicParams
}

export const XiaoAiCastModal: React.FC<Props> = ({ visible, onClose, currentMusic }) => {
  const theme = useTheme()
  const [devices, setDevices] = useState<XiaoAiDevice[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [selectedDids, setSelectedDids] = useState<string[]>([])
  const [casting, setCasting] = useState<boolean>(false)

  const loadDevices = useCallback(async() => {
    setLoading(true)
    try {
      const list = await xiaoaiService.getDevices(true)
      setDevices(list)
      if (list.length > 0 && selectedDids.length === 0) {
        const defaultDids = [list[0].did]
        setSelectedDids(defaultDids)
        void xiaoaiService.setSelectedDids(defaultDids)
      }
    } catch (err: unknown) {
      showToast(`拉取音箱失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [selectedDids])

  useEffect(() => {
    if (visible) {
      void loadDevices()
      setSelectedDids(xiaoaiService.getSelectedDids())
    }
  }, [visible, loadDevices])

  const showToast = (msg: string) => {
    if (Platform.OS === 'android') {
      ToastAndroid.show(msg, ToastAndroid.SHORT)
    } else {
      Alert.alert('提示', msg)
    }
  }

  const toggleSelect = (did: string) => {
    let next: string[]
    if (selectedDids.includes(did)) {
      next = selectedDids.filter((id) => id !== did)
    } else {
      next = [...selectedDids, did]
    }
    setSelectedDids(next)
    void xiaoaiService.setSelectedDids(next)
  }

  const selectAll = () => {
    const all = devices.map((d) => d.did)
    setSelectedDids(all)
    void xiaoaiService.setSelectedDids(all)
  }

  const handleCast = async() => {
    if (!currentMusic) {
      showToast('当前没有选中可投播的歌曲')
      return
    }
    if (selectedDids.length === 0) {
      showToast('请至少选择一台小爱音箱')
      return
    }

    setCasting(true)
    try {
      await xiaoaiService.castSong(currentMusic, selectedDids)
      showToast(`已成功投播至 ${selectedDids.length} 台小爱音箱 🎵`)
      onClose()
    } catch (err: unknown) {
      showToast(`投播失败: ${(err as Error).message}`)
    } finally {
      setCasting(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, { backgroundColor: theme['c-content-background'] || theme['c-100'] }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme['c-font'] }]}>🔊 投播到小爱音箱</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={[styles.closeBtn, { color: theme['c-font-label'] }]}>✕</Text>
            </TouchableOpacity>
          </View>

          {currentMusic && (
            <View style={[styles.musicCard, { backgroundColor: theme['c-200'] }]}>
              <Text style={[styles.musicTitle, { color: theme['c-font'] }]} numberOfLines={1}>
                {currentMusic.name}
              </Text>
              <Text style={[styles.musicArtist, { color: theme['c-font-label'] }]} numberOfLines={1}>
                {currentMusic.singer} • {currentMusic.source.toUpperCase()}
              </Text>
            </View>
          )}

          <View style={styles.deviceHeader}>
            <Text style={[styles.subTitle, { color: theme['c-font-label'] }]}>
              选择播放设备 ({selectedDids.length}/{devices.length})
            </Text>
            <View style={styles.actionLinks}>
              <TouchableOpacity onPress={selectAll}>
                <Text style={[styles.linkText, { color: theme['c-primary'] }]}>全选</Text>
              </TouchableOpacity>
              <Text style={{ color: theme['c-font-label'], marginHorizontal: 6 }}>|</Text>
              <TouchableOpacity onPress={loadDevices}>
                <Text style={[styles.linkText, { color: theme['c-primary'] }]}>刷新</Text>
              </TouchableOpacity>
            </View>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color={theme['c-primary']} style={{ marginVertical: 30 }} />
          ) : (
            <ScrollView style={styles.deviceList}>
              {devices.length === 0 ? (
                <Text style={[styles.emptyText, { color: theme['c-font-label'] }]}>
                  未发现音箱，请在云端服务检查小米账号配置
                </Text>
              ) : (
                devices.map((dev) => {
                  const isSelected = selectedDids.includes(dev.did)
                  return (
                    <TouchableOpacity
                      key={dev.did}
                      style={[
                        styles.deviceItem,
                        { borderColor: isSelected ? theme['c-primary'] : theme['c-200'] },
                        isSelected && { backgroundColor: `${theme['c-primary']}15` },
                      ]}
                      onPress={() => { toggleSelect(dev.did) }}
                    >
                      <View>
                        <Text style={[styles.deviceName, { color: theme['c-font'] }]}>{dev.name}</Text>
                        <Text style={[styles.deviceModel, { color: theme['c-font-label'] }]}>
                          {dev.model || '小爱音箱'}
                        </Text>
                      </View>
                      <View style={[styles.checkbox, isSelected && { backgroundColor: theme['c-primary'] }]}>
                        {isSelected && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                    </TouchableOpacity>
                  )
                })
              )}
            </ScrollView>
          )}

          <TouchableOpacity
            style={[styles.castBtn, { backgroundColor: theme['c-primary'] }]}
            onPress={handleCast}
            disabled={casting}
          >
            {casting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.castBtnText}>一键开始投播</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  container: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  closeBtn: {
    fontSize: 20,
    padding: 4,
  },
  musicCard: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 14,
  },
  musicTitle: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  musicArtist: {
    fontSize: 12,
    marginTop: 2,
  },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  subTitle: {
    fontSize: 13,
  },
  actionLinks: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  linkText: {
    fontSize: 13,
    fontWeight: 'bold',
  },
  deviceList: {
    maxHeight: 220,
  },
  deviceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '600',
  },
  deviceModel: {
    fontSize: 11,
    marginTop: 2,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#94a3b8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkmark: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  emptyText: {
    textAlign: 'center',
    marginVertical: 30,
    fontSize: 13,
  },
  castBtn: {
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 14,
  },
  castBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
})

