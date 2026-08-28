import { memo, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { useI18n } from '@/lang'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useTheme } from '@/store/theme/hook'
import { Icon } from '@/components/common/Icon'
import { confirmDialog, createStyle, exitApp as backHome } from '@/utils/tools'
import { NAV_MENUS } from '@/config/constant'
import type { InitState } from '@/store/common/state'
import { exitApp, setNavActiveId } from '@/core/common'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import { XiaoAiTTSModal } from '@/components/XiaoAiTTSModal'
import { XiaoAiCastModal } from '@/components/XiaoAiCastModal'

const styles = createStyle({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: 30,
    paddingBottom: 35,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerText: {
    fontWeight: 'bold',
  },
  menus: {
    flex: 1,
  },
  list: {
    paddingTop: 10,
    paddingBottom: 10,
  },
  menuItem: {
    flexDirection: 'row',
    paddingTop: 13,
    paddingBottom: 13,
    paddingLeft: 25,
    paddingRight: 25,
    alignItems: 'center',
  },
  iconContent: {
    width: 24,
    alignItems: 'center',
  },
  text: {
    paddingLeft: 20,
  },
  xiaoaiSection: {
    marginTop: 10,
    paddingTop: 15,
    borderTopWidth: 1,
  },
  sectionTitle: {
    paddingLeft: 25,
    paddingBottom: 6,
    fontWeight: 'bold',
  },
})

const Header = () => {
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()
  return (
    <View style={{ paddingTop: statusBarHeight, backgroundColor: theme['c-primary-light-700-alpha-500'] }}>
      <View style={styles.header}>
        <Icon name="logo" color={theme['c-primary-dark-100-alpha-300']} size={26} />
        <View style={{ marginLeft: 12 }}>
          <Text style={styles.headerText} size={20} color={theme['c-primary-dark-100-alpha-300']}>XiaoAi SoundHub</Text>
          <Text size={12} color={theme['c-primary-dark-100-alpha-300']}>小爱声枢 • 音乐控制中枢</Text>
        </View>
      </View>
    </View>
  )
}

type StandardIdType = InitState['navActiveId'] | 'nav_exit' | 'back_home'
type IdType = StandardIdType | 'xiaoai_tts' | 'xiaoai_cast'

const MenuItem = ({ id, icon, onPress, label }: {
  id: IdType
  icon: string
  onPress: (id: IdType) => void
  label?: string
}) => {
  const t = useI18n()
  const activeId = useNavActiveId()
  const theme = useTheme()
  const displayLabel = label ?? (id === 'xiaoai_tts' || id === 'xiaoai_cast' ? id : t(id))

  return activeId == id
    ? <View style={styles.menuItem}>
        <View style={styles.iconContent}>
          <Icon name={icon} size={20} color={theme['c-primary-font-active']} />
        </View>
        <Text style={styles.text} color={theme['c-primary-font']}>{displayLabel}</Text>
      </View>
    : <TouchableOpacity style={styles.menuItem} onPress={() => { onPress(id) }}>
        <View style={styles.iconContent}>
          <Icon name={icon} size={20} color={theme['c-font-label']} />
        </View>
        <Text style={styles.text}>{displayLabel}</Text>
      </TouchableOpacity>
}

export default memo(() => {
  const theme = useTheme()
  // console.log('render drawer nav')
  const showBackBtn = useSettingValue('common.showBackBtn')
  const showExitBtn = useSettingValue('common.showExitBtn')
  const [ttsVisible, setTtsVisible] = useState(false)
  const [castVisible, setCastVisible] = useState(false)

  const handlePress = (id: IdType) => {
    switch (id) {
      case 'xiaoai_tts':
        global.app_event.changeMenuVisible(false)
        setTtsVisible(true)
        return
      case 'xiaoai_cast':
        global.app_event.changeMenuVisible(false)
        setCastVisible(true)
        return
      case 'nav_exit':
        void confirmDialog({
          message: global.i18n.t('exit_app_tip'),
          confirmButtonText: global.i18n.t('list_remove_tip_button'),
        }).then(isExit => {
          if (!isExit) return
          exitApp('Exit Btn')
        })
        return
      case 'back_home':
        backHome()
        return
    }

    global.app_event.changeMenuVisible(false)
    setNavActiveId(id)
  }


  return (
    <View style={{ ...styles.container, backgroundColor: theme['c-content-background'] }}>
      <Header />
      <ScrollView style={styles.menus}>
        <View style={styles.list}>
          {NAV_MENUS.map(menu => <MenuItem key={menu.id} id={menu.id} icon={menu.icon} onPress={handlePress} />)}
        </View>

        <View style={[styles.xiaoaiSection, { borderTopColor: theme['c-200'] }]}>
          <Text style={[styles.sectionTitle, { color: theme['c-primary-font'] }]} size={12}>小爱音箱专属功能</Text>
          <TouchableOpacity style={styles.menuItem} onPress={() => { handlePress('xiaoai_tts') }}>
            <View style={styles.iconContent}>
              <Text size={18}>📢</Text>
            </View>
            <Text style={styles.text}>全屋语音播报 (TTS)</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => { handlePress('xiaoai_cast') }}>
            <View style={styles.iconContent}>
              <Text size={18}>🔊</Text>
            </View>
            <Text style={styles.text}>小爱多音箱投播</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {
        showBackBtn ? <MenuItem id="back_home" icon="home" onPress={handlePress} /> : null
      }
      {
        showExitBtn ? <MenuItem id="nav_exit" icon="exit2" onPress={handlePress} /> : null
      }

      <XiaoAiTTSModal visible={ttsVisible} onClose={() => { setTtsVisible(false) }} />
      <XiaoAiCastModal visible={castVisible} onClose={() => { setCastVisible(false) }} />
    </View>
  )
})

