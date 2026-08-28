import { memo, useRef } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import Text from '@/components/common/Text'
import FileSelect, { type FileSelectType } from '@/components/common/FileSelect'
import { updateSetting } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'
import { getMusicDownloadDirectoryPath } from '@/utils/fs'
import { createStyle } from '@/utils/tools'

export default memo(() => {
  const fileSelectRef = useRef<FileSelectType>(null)
  const savePath = useSettingValue('download.savePath')
  const currentPath = savePath.trim() || getMusicDownloadDirectoryPath()

  const handleSelectPath = () => {
    fileSelectRef.current?.show({
      title: '选择下载目录',
      dirOnly: true,
    }, (path) => {
      updateSetting({ 'download.savePath': path })
    })
  }

  const handleReset = () => {
    updateSetting({ 'download.savePath': '' })
  }

  return (
    <SubTitle title="下载路径">
      <View style={styles.container}>
        <Text style={styles.pathText} selectable>{currentPath}</Text>
        <View style={styles.actions}>
          <Button onPress={handleSelectPath}>选择目录</Button>
          <Button onPress={handleReset}>恢复默认</Button>
        </View>
      </View>
      <FileSelect ref={fileSelectRef} />
    </SubTitle>
  )
})

const styles = createStyle({
  container: {
    paddingRight: 15,
  },
  pathText: {
    marginBottom: 10,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
