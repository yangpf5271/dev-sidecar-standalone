const lodash = require('lodash')

function deleteNullItems (target) {
  lodash.forEach(target, (item, key) => {
    if (item == null || item === '[delete]') {
      delete target[key]
    }
    if (lodash.isObject(item)) {
      deleteNullItems(item)
    }
  })
}

module.exports = {
  doMerge (oldObj, newObj) {
    return lodash.mergeWith(oldObj, newObj, (objValue, srcValue) => {
      if (lodash.isArray(objValue)) {
        return srcValue
      }
    })
  },
  deleteNullItems,
}
