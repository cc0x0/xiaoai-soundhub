import { memo } from 'react'
import { View } from 'react-native'

import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle } from '@/utils/tools'

import CheckBoxItem from '../../components/CheckBoxItem'
import SubTitle from '../../components/SubTitle'

export default memo(() => {
  const t = useI18n()
  const isEmbedPic = useSettingValue('download.isEmbedPic')

  const handleChange = (isEmbedPic: boolean) => {
    updateSetting({ 'download.isEmbedPic': isEmbedPic })
  }

  return (
    <SubTitle title={t('setting_download_album_pic')}>
      <View style={styles.content}>
        <CheckBoxItem check={isEmbedPic} onChange={handleChange} label={t('setting_download_embed_pic')} />
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
