// Keeps the computer from sleeping while any conversation is running, so long
// tasks are not cut off; the display may still turn off.
class KeepAwake{
  constructor(blocker){this.blocker=blocker;this.id=null;}
  update(busy){
    if(busy&&this.id===null)this.id=this.blocker.start('prevent-app-suspension');
    else if(!busy&&this.id!==null){if(this.blocker.isStarted(this.id))this.blocker.stop(this.id);this.id=null;}
    return this.id!==null;
  }
}
module.exports={KeepAwake};
