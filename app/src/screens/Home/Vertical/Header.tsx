import { useState } from 'react'
import { View, TouchableOpacity } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import StatusBar from '@/components/common/StatusBar'
import { useSettingValue } from '@/store/setting/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT } from '@/config/constant'
import { type InitState as CommonState } from '@/store/common/state'
import SearchTypeSelector from '@/screens/Home/Views/Search/SearchTypeSelector'
import { XiaoAiTTSModal } from '@/components/XiaoAiTTSModal'
import { XiaoAiCastModal } from '@/components/XiaoAiCastModal'

const headerComponents: Partial<Record<CommonState['navActiveId'], React.ReactNode>> = {
  nav_search: <SearchTypeSelector />,
}


// const LeftTitle = () => {
//   const id = useNavActiveId()
//   const t = useI18n()

//   return <Text style={styles.leftTitle} size={18}>{t(id)}</Text>
// }
const LeftHeader = () => {
  const theme = useTheme()
  const id = useNavActiveId()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  const [ttsVisible, setTtsVisible] = useState(false)
  const [castVisible, setCastVisible] = useState(false)

  const openMenu = () => {
    global.app_event.changeMenuVisible(true)
  }

  return (
    <View style={{
      ...styles.container,
      height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
      paddingTop: statusBarHeight,
    }}>
      <View style={styles.left}>
        <TouchableOpacity style={styles.btn} onPress={openMenu}>
          <Icon color={theme['c-font']} name="menu" size={18} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.titleBtn} onPress={openMenu}>
          <Text style={styles.leftTitle} size={18}>{t(id)}</Text>
        </TouchableOpacity>
      </View>
      {headerComponents[id] ?? null}

      <View style={styles.xiaoaiActions}>
        <TouchableOpacity style={styles.xiaoaiBtn} onPress={() => { setTtsVisible(true) }}>
          <Text style={[styles.xiaoaiBtnText, { color: theme['c-primary-font'] }]} size={12}>📢 播报</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.xiaoaiBtn} onPress={() => { setCastVisible(true) }}>
          <Text style={[styles.xiaoaiBtnText, { color: theme['c-primary-font'] }]} size={12}>🔊 投播</Text>
        </TouchableOpacity>
      </View>

      <XiaoAiTTSModal visible={ttsVisible} onClose={() => { setTtsVisible(false) }} />
      <XiaoAiCastModal visible={castVisible} onClose={() => { setCastVisible(false) }} />
    </View>
  )
}


// const RightTitle = () => {
//   const id = useNavActiveId()
//   const t = useI18n()

//   return <Text style={styles.rightTitle} size={18}>{t(id)}</Text>
// }
const RightHeader = () => {
  const theme = useTheme()
  const t = useI18n()
  const id = useNavActiveId()
  const statusBarHeight = useStatusbarHeight()

  const [ttsVisible, setTtsVisible] = useState(false)
  const [castVisible, setCastVisible] = useState(false)

  const openMenu = () => {
    global.app_event.changeMenuVisible(true)
  }
  return (
    <View style={{
      ...styles.container,
      height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
      paddingTop: statusBarHeight,
    }}>
      <View style={styles.left}>
        <TouchableOpacity style={styles.titleBtn} onPress={openMenu}>
          <Text style={styles.rightTitle} size={18}>{t(id)}</Text>
        </TouchableOpacity>
      </View>
      {headerComponents[id] ?? null}
      <View style={styles.xiaoaiActions}>
        <TouchableOpacity style={styles.xiaoaiBtn} onPress={() => { setTtsVisible(true) }}>
          <Text style={[styles.xiaoaiBtnText, { color: theme['c-primary-font'] }]} size={12}>📢 播报</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.xiaoaiBtn} onPress={() => { setCastVisible(true) }}>
          <Text style={[styles.xiaoaiBtnText, { color: theme['c-primary-font'] }]} size={12}>🔊 投播</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.btn} onPress={openMenu}>
        <Icon color={theme['c-font']} name="menu" size={18} />
      </TouchableOpacity>

      <XiaoAiTTSModal visible={ttsVisible} onClose={() => { setTtsVisible(false) }} />
      <XiaoAiCastModal visible={castVisible} onClose={() => { setCastVisible(false) }} />
    </View>
  )
}

const Header = () => {
  const drawerLayoutPosition = useSettingValue('common.drawerLayoutPosition')

  return (
    <>
      <StatusBar />
      {
        drawerLayoutPosition == 'left'
          ? <LeftHeader />
          : <RightHeader />
      }

    </>
  )
}


const styles = createStyle({
  container: {
    // width: '100%',
    paddingRight: 5,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    // backgroundColor: 'rgba(0,0,0,0.1)',
    zIndex: 10,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    paddingLeft: 5,
    alignItems: 'center',
    height: '100%',
  },
  btn: {
    // flex: 1,
    width: HEADER_HEIGHT,
    // backgroundColor: 'rgba(0,0,0,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  titleBtn: {
    flex: 1,
    // backgroundColor: 'rgba(0,0,0,0.1)',
    height: '100%',
    justifyContent: 'center',
  },
  leftTitle: {
    paddingLeft: 14,
    paddingRight: 16,
  },
  rightTitle: {
    paddingLeft: 16,
    paddingRight: 16,
  },
  xiaoaiActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginRight: 6,
  },
  xiaoaiBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  xiaoaiBtnText: {
    fontWeight: '600',
  },
})

export default Header
