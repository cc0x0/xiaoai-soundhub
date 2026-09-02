/**
 * 小爱云端惰性鉴权弹窗 (XiaoAiAuthModal)
 *
 * Local playback never needs an account. This modal only appears at the moment
 * a cloud capability is actually used (casting, TTS, device management), so a
 * user who only listens on their phone is never asked to sign up.
 */

import { useState, useEffect } from 'react'
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native'
import { xiaoaiService, DEFAULT_SERVER_URL } from '@/services/xiaoaiService'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'

interface Props {
  visible: boolean
  onClose: () => void
  /** Called once a token is in hand, so the caller can retry what it was doing. */
  onAuthorized: () => void
  /** Why the prompt appeared, shown so the ask does not feel arbitrary. */
  purpose?: string
}

export const XiaoAiAuthModal: React.FC<Props> = ({ visible, onClose, onAuthorized, purpose }) => {
  const theme = useTheme()
  const [serverUrl, setServerUrl] = useState<string>('')
  const [username, setUsername] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [isRegister, setIsRegister] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)

  useEffect(() => {
    if (visible) {
      setServerUrl(xiaoaiService.getServerUrl() || DEFAULT_SERVER_URL)
      setPassword('')
    }
  }, [visible])

  const handleSubmit = async() => {
    const url = serverUrl.trim()
    const name = username.trim()
    if (!url) {
      toast('请填写云端服务地址')
      return
    }
    if (!name || !password) {
      toast('请输入用户名和密码')
      return
    }
    if (isRegister && (name.length < 3 || password.length < 6)) {
      toast('用户名至少 3 位，密码至少 6 位')
      return
    }

    setBusy(true)
    try {
      // Persist the address first: a login attempt against the old address would
      // fail confusingly right after the user corrected it.
      await xiaoaiService.setServerUrl(url)
      await xiaoaiService.login(name, password, isRegister)
      toast(isRegister ? '🎉 注册成功，已自动登录' : '✅ 云端绑定成功')
      onAuthorized()
      onClose()
    } catch (err: unknown) {
      toast(`${isRegister ? '注册' : '登录'}失败: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = [
    styles.input,
    {
      backgroundColor: theme['c-200'],
      color: theme['c-font'],
      borderColor: theme['c-300'] || theme['c-200'],
    },
  ]

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, { backgroundColor: theme['c-content-background'] || theme['c-100'] }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme['c-font'] }]}>
              {isRegister ? '🆕 注册云端账号' : '🔑 绑定小爱云端'}
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={[styles.closeBtn, { color: theme['c-font-label'] }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.desc, { color: theme['c-font-label'] }]}>
            {purpose ?? '本机播放无需登录。绑定云端后才能投播到小爱音箱、语音播报与管理设备。'}
          </Text>

          <Text style={[styles.label, { color: theme['c-font-label'] }]}>云端服务地址</Text>
          <TextInput
            style={inputStyle}
            placeholder={DEFAULT_SERVER_URL}
            placeholderTextColor={theme['c-font-label']}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={[styles.label, { color: theme['c-font-label'] }]}>用户名</Text>
          <TextInput
            style={inputStyle}
            placeholder="云端账号用户名"
            placeholderTextColor={theme['c-font-label']}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={[styles.label, { color: theme['c-font-label'] }]}>密码</Text>
          <TextInput
            style={inputStyle}
            placeholder={isRegister ? '至少 6 位' : '账号密码'}
            placeholderTextColor={theme['c-font-label']}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
          />

          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: theme['c-primary'] }, busy && styles.disabled]}
            onPress={handleSubmit}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>{isRegister ? '注册并登录' : '登录并继续'}</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.switchRow} onPress={() => { setIsRegister(!isRegister) }}>
            <Text style={[styles.switchText, { color: theme['c-primary'] }]}>
              {isRegister ? '已有账号？返回登录' : '还没有账号？立即注册'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}

const styles = createStyle({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  container: {
    borderRadius: 14,
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: 'bold',
  },
  closeBtn: {
    fontSize: 20,
    padding: 4,
  },
  desc: {
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 14,
  },
  label: {
    fontSize: 12,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 12,
  },
  submitBtn: {
    padding: 13,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  disabled: {
    opacity: 0.5,
  },
  submitText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  switchRow: {
    alignItems: 'center',
    marginTop: 12,
  },
  switchText: {
    fontSize: 12,
    fontWeight: '600',
  },
})
