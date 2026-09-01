import { memo, useState, useEffect } from 'react'
import { View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native'
import Section from '../../components/Section'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { xiaoaiService, DEFAULT_SERVER_URL, type XiaoAiDevice } from '@/services/xiaoaiService'
import { XiaoAiTTSModal } from '@/components/XiaoAiTTSModal'
import { XiaoAiCastModal } from '@/components/XiaoAiCastModal'

export default memo(() => {
  const theme = useTheme()
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [token, setToken] = useState('')
  const [devices, setDevices] = useState<XiaoAiDevice[]>([])
  const [testing, setTesting] = useState(false)
  const [ttsModalVisible, setTtsModalVisible] = useState(false)
  const [castModalVisible, setCastModalVisible] = useState(false)

  useEffect(() => {
    setServerUrl(xiaoaiService.getServerUrl() || DEFAULT_SERVER_URL)
    setToken(xiaoaiService.getToken() || '')
  }, [])

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
    } catch (err: unknown) {
      toast(`连接失败: ${(err as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

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
            <Text style={styles.actionChipText}>🔊 小爱音箱投播面板</Text>
          </TouchableOpacity>
        </View>

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

