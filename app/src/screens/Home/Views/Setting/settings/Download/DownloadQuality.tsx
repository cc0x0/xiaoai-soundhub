import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { TRY_QUALITYS_LIST } from '@/core/music/utils'

const useActive = (id: LX.Quality) => {
  const q = useSettingValue('download.quality')
  return useMemo(() => q == id, [q, id])
}

const Item = ({ id, name }: {
  id: LX.Quality
  name: string
}) => {
  const isActive = useActive(id)
  return <CheckBox marginRight={8} check={isActive} label={name} onChange={() => { updateSetting({ 'download.quality': id }) }} need />
}

export default memo(() => {
  const qualityList = useMemo(() => {
    return [...TRY_QUALITYS_LIST, '128k'].reverse() as LX.Quality[]
  }, [])

  return (
    <SubTitle title="下载音质">
      <View style={styles.list}>
        {qualityList.map((q) => <Item name={q} id={q} key={q} />)}
      </View>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
