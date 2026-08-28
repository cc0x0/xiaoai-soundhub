import { memo } from 'react'

import SavePath from './SavePath'
import DownloadQuality from './DownloadQuality'
import EmbedPic from './EmbedPic'
import EmbedLyric from './EmbedLyric'

export default memo(() => {
  return (
    <>
      <SavePath />
      <DownloadQuality />
      <EmbedPic />
      <EmbedLyric />
    </>
  )
})
