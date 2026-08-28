/**
 * 小爱多音箱文本语音 (TTS) 广播弹窗组件
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
  Alert,
  Platform,
} from 'react-native'
import { xiaoaiService, type XiaoAiDevice } from '@/services/xiaoaiService'
import { useTheme } from '@/store/theme/hook'

interface Props {
  visible: boolean
  onClose: () => void
}

const PRESETS = [
  '准备开饭啦！',
  '该起床啦，新的一天开始啦！',
  '主人，您的快递已送达。',
  '主人，这是一条全屋语音播报测试。',
  '出门记得带好钥匙和手机哦。',
]

export const XiaoAiTTSModal: React.FC<Props> = ({ visible, onClose }) => {
  const theme = useTheme()
  const [text, setText] = useState<string>('')
  const [devices, setDevices] = useState<XiaoAiDevice[]>([])
  const [selectedDids, setSelectedDids] = useState<string[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [sending, setSending] = useState<boolean>(false)

  const showToast = (msg: string) => {
    if (Platform.OS === 'android') {
      ToastAndroid.show(msg, ToastAndroid.SHORT)
    } else {
      Alert.alert('提示', msg)
    }
  }

  const loadDevices = useCallback(async() => {
    setLoading(true)
    try {
      const list = await xiaoaiService.getDevices(true)
      setDevices(list)
      if (list.length > 0 && selectedDids.length === 0) {
        const all = list.map((d) => d.did)
        setSelectedDids(all)
        void xiaoaiService.setSelectedDids(all)
      }
    } catch (err: unknown) {
      showToast(`拉取设备失败: ${(err as Error).message}`)
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

  const handleSend = async() => {
    const content = text.trim()
    if (!content) {
      showToast('请输入要播报的文本')
      return
    }
    if (selectedDids.length === 0) {
      showToast('请至少选择一台音箱')
      return
    }

    setSending(true)
    try {
      await xiaoaiService.sendTTS(content, selectedDids)
      showToast(`📢 已向 ${selectedDids.length} 台小爱音箱下发语音播报！`)
      onClose()
    } catch (err: unknown) {
      showToast(`播报失败: ${(err as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, { backgroundColor: theme['c-content-background'] || theme['c-100'] }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme['c-font'] }]}>📢 小爱多音箱 TTS 广播</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={[styles.closeBtn, { color: theme['c-font-label'] }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={[
              styles.input,
              { backgroundColor: theme['c-200'], color: theme['c-font'], borderColor: theme['c-300'] || theme['c-200'] },
            ]}
            placeholder="输入要播报的文本内容..."
            placeholderTextColor={theme['c-font-label']}
            multiline
            numberOfLines={3}
            value={text}
            onChangeText={setText}
          />

          <View style={styles.presetContainer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {PRESETS.map((preset, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[styles.presetChip, { backgroundColor: theme['c-200'] }]}
                  onPress={() => { setText(preset) }}
                >
                  <Text style={[styles.presetText, { color: theme['c-font'] }]}>{preset}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <Text style={[styles.subTitle, { color: theme['c-font-label'], marginTop: 10, marginBottom: 8 }]}>
            目标音箱 ({selectedDids.length}/{devices.length})
          </Text>

          {loading ? (
            <ActivityIndicator size="small" color={theme['c-primary']} style={{ marginVertical: 20 }} />
          ) : (
            <ScrollView style={styles.deviceList}>
              {devices.map((dev) => {
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
                    <Text style={[styles.deviceName, { color: theme['c-font'] }]}>{dev.name}</Text>
                    <View style={[styles.checkbox, isSelected && { backgroundColor: theme['c-primary'] }]}>
                      {isSelected && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          )}

          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: theme['c-primary'] }]}
            onPress={handleSend}
            disabled={sending}
          >
            {sending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.sendBtnText}>一键全屋广播播报</Text>
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
    maxHeight: '85%',
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
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    textAlignVertical: 'top',
    height: 80,
  },
  presetContainer: {
    marginVertical: 10,
  },
  presetChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 8,
  },
  presetText: {
    fontSize: 12,
  },
  subTitle: {
    fontSize: 13,
  },
  deviceList: {
    maxHeight: 180,
  },
  deviceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 6,
  },
  deviceName: {
    fontSize: 14,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#94a3b8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkmark: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  sendBtn: {
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 14,
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
})

