module.exports = {
  format (date, needMill = true) {
    if (date == null) {
      return 'null'
    }
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    const milliseconds = needMill ? `.${date.getMilliseconds().toString().padStart(3, '0')}` : ''
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}${milliseconds}`
  },
  now (needMill = true) {
    return this.format(new Date(), needMill)
  },
}
