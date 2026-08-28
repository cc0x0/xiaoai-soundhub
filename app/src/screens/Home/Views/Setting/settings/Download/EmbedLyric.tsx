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
  const isEmbedLyric = useSettingValue('download.isEmbedLyric')
  const isEmbedLyricTranslation = useSettingValue('download.isEmbedLyricTranslation')
  const isEmbedLyricRoma = useSettingValue('download.isEmbedLyricRoma')
  const isEmbedLyricAwlrc = useSettingValue('download.isEmbedLyricAwlrc')

  const handleChange = (isEmbedLyric: boolean) => {
    updateSetting({ 'download.isEmbedLyric': isEmbedLyric })
  }
  const handleChangeTranslation = (isEmbedLyricTranslation: boolean) => {
    updateSetting({ 'download.isEmbedLyricTranslation': isEmbedLyricTranslation })
  }
  const handleChangeRoma = (isEmbedLyricRoma: boolean) => {
    updateSetting({ 'download.isEmbedLyricRoma': isEmbedLyricRoma })
  }
  const handleChangeAwlrc = (isEmbedLyricAwlrc: boolean) => {
    updateSetting({ 'download.isEmbedLyricAwlrc': isEmbedLyricAwlrc })
  }

  return (
    <SubTitle title={t('setting_download_lyric')}>
      <View style={styles.content}>
        <CheckBoxItem check={isEmbedLyric} onChange={handleChange} label={t('setting_download_embed_lyric')} />
        {isEmbedLyric
          ? (
              <View style={styles.children}>
                <CheckBoxItem check={isEmbedLyricTranslation} onChange={handleChangeTranslation} label={t('setting_download_embed_lyric_translation')} />
                <CheckBoxItem check={isEmbedLyricRoma} onChange={handleChangeRoma} label={t('setting_download_embed_lyric_roma')} />
                <CheckBoxItem check={isEmbedLyricAwlrc} onChange={handleChangeAwlrc} label={t('setting_download_embed_lyric_awlrc')} />
              </View>
            )
          : null}
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
  children: {
    marginTop: 4,
    paddingLeft: 15,
  },
})
